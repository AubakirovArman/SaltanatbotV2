import { randomUUID } from "node:crypto";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { findInstrument } from "../market/catalog.js";
import { timeframeMs } from "../market/timeframes.js";
import { ProviderRouter } from "../providers/router.js";
import type { MarketSubscription } from "../providers/provider.js";
import { commandToExec, formatExec, parseMessageSet } from "./commands.js";
import { findLiveCollision } from "./collision.js";
import { atrValue, evaluateBar, runInit, type BarIntents } from "./strategy/evaluator.js";
import { PaperAdapter, type PaperState } from "./exchange/paper.js";
import { BinanceAdapter, type ExchangeKeys } from "./exchange/binance.js";
import { BybitAdapter } from "./exchange/bybit.js";
import { notify } from "./notifications.js";
import { getSetting, insertFill, insertLog, listBots, listFills, setSetting, upsertBot } from "./store.js";
import type {
  AccountState,
  BotConfig,
  ExchangeAdapter,
  ExecOrder,
  ExecResult,
  FillRecord,
  PortfolioExchange,
  PortfolioSummary,
  PositionState
} from "./types.js";

const BUFFER_CAP = 1500;
/**
 * History seeded before a live bot starts evaluating, so indicators have warmup.
 * NOTE: a live bot only evaluates bars that close AFTER it starts, so `setvar`
 * counters (e.g. "entries so far", loss streaks) begin at the start moment —
 * whereas a backtest accumulates them from bar 0 of history. For strategies whose
 * decisions depend on absolute counts over all history, backtest and live will
 * therefore diverge by construction; counters should be framed as "since start".
 */
const SEED_BARS = 500;

export interface TradeEvent {
  type: "bot" | "fill" | "log" | "signal";
  botId: string;
  bot?: BotConfig;
  fill?: FillRecord;
  log?: { level: string; message: string; ts: number };
  signal?: { dir: "up" | "down"; label: string; price: number; ts: number };
  account?: AccountState;
  position?: PositionState | null;
}

interface Managed {
  side: "long" | "short";
  entry: number;
  /** Filled base quantity — used for unrealized-PnL ctx reads. */
  qty: number;
  /** Bar time at entry — used for bars-in-position ctx reads. */
  entryTime: number;
  stop?: number;
  target?: number;
  trail?: { mode: "percent" | "atr"; value: number };
}

/**
 * Durable strategy runtime state, persisted to `state:<botId>` so a process
 * restart/crash does NOT wipe `setvar` counters (which would reset martingale
 * steps / loss streaks) or the managed-position tracking (whose loss would make
 * the strategy see "flat" and re-enter an already-open live position).
 */
interface BotStateSnapshot {
  vars: Record<string, number>;
  managed?: Managed;
  /** Time of the last bar this bot evaluated — used for the resume staleness gate. */
  lastBarTime: number;
  savedAt: number;
}

interface RunningBot {
  config: BotConfig;
  adapter: ExchangeAdapter;
  paper?: PaperAdapter;
  instrument: Instrument;
  buffer: Candle[];
  sub?: MarketSubscription;
  price: number;
  managed?: Managed;
  /** Persistent `setvar` store — survives across bars for backtest/live parity. */
  vars: Map<string, number>;
  /**
   * True when the bot was auto-resumed with stale risky state (open position or
   * nonzero counters after a long downtime). It buffers data but does NOT trade
   * until an operator confirms via confirmResume() — see the resume staleness gate.
   */
  paused?: boolean;
}

export class TradingEngine {
  private running = new Map<string, RunningBot>();

  constructor(
    private readonly provider: ProviderRouter,
    private readonly broadcast: (event: TradeEvent) => void
  ) {}

  isRunning(id: string) {
    return this.running.has(id);
  }

  async liveState(id: string): Promise<{ account?: AccountState; position?: PositionState | null; price: number; paused: boolean } | null> {
    const bot = this.running.get(id);
    if (!bot) return null;
    return {
      account: await bot.adapter.account().catch(() => undefined),
      position: await bot.adapter.position(bot.config.symbol).catch(() => null),
      price: bot.price,
      paused: bot.paused === true
    };
  }

  /**
   * Detect a live-on-live collision: another RUNNING live bot on the same
   * exchange+symbol would fight this one (its close flattens the shared
   * position, its cancelAll cancels the other's orders). Paper bots are
   * isolated sims and never collide. Returns the offending bot's config, if any.
   */
  liveCollision(config: BotConfig): BotConfig | undefined {
    return findLiveCollision(config, [...this.running.values()].map((bot) => bot.config));
  }

  async start(config: BotConfig, options: { override?: boolean; resumed?: boolean } = {}) {
    if (this.running.has(config.id)) return;
    const instrument = findInstrument(config.symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${config.symbol}`);

    // Guard against two live bots fighting over one exchange+symbol.
    if (!options.override) {
      const clash = this.liveCollision(config);
      if (clash) {
        throw new Error(`A live bot is already running on ${config.exchange} ${config.symbol} ("${clash.name}"). Stop it first or pass override to run both.`);
      }
    }

    const adapter = this.buildAdapter(config, () => this.running.get(config.id)?.price ?? 0);
    const bot: RunningBot = { config, adapter, instrument, buffer: [], price: 0, vars: new Map() };
    if (adapter instanceof PaperAdapter) {
      bot.paper = adapter;
      const saved = getSetting<PaperState>(`paper:${config.id}`);
      if (saved) adapter.setState(saved);
    }

    // Restore durable strategy state (setvar counters + managed-position tracking)
    // so a restart doesn't reset counters or lose track of an open position.
    const savedState = getSetting<BotStateSnapshot>(`state:${config.id}`);
    if (savedState) {
      for (const [name, value] of Object.entries(savedState.vars ?? {})) bot.vars.set(name, value);
      bot.managed = savedState.managed;
      // Resume staleness gate: if the bot comes back with risky state (an open
      // position or nonzero counters) after a long gap, don't blindly resume
      // trading — buffer only and wait for operator confirmation. A lost loss
      // streak would resume a bot that should be dead; a stale one would gate on
      // a dead regime. Human confirm is the only safe default for both.
      const hasRisk = !!bot.managed || Object.values(savedState.vars ?? {}).some((v) => v !== 0);
      const gap = Date.now() - (savedState.lastBarTime || 0);
      const stale = gap > 3 * (timeframeMs[config.timeframe] ?? 60_000);
      if (options.resumed && hasRisk && stale) bot.paused = true;
    }

    // Live bots must never see synthetic fallback data — trade on real prices only.
    const strict = config.exchange !== "paper";

    // Seed history so indicators have warmup.
    const seed = await this.provider.getCandles(instrument, config.timeframe, { limit: SEED_BARS }, { strict });
    bot.buffer = seed.slice(-BUFFER_CAP);
    bot.price = bot.buffer.at(-1)?.close ?? 0;

    // Fresh start (no restored state): run the strategy's one-time on-start init.
    if (!savedState) runInit(config.ir, bot.buffer, bot.vars);

    bot.sub = await this.provider.subscribe(
      instrument,
      config.timeframe,
      (candle) => this.onCandle(config.id, candle),
      (message) => this.log(config.id, message.toLowerCase().includes("error") || message.toLowerCase().includes("closed") ? "warn" : "info", message),
      { strict }
    );

    this.running.set(config.id, bot);
    config.status = "running";
    config.updatedAt = Date.now();
    upsertBot(config);
    this.log(config.id, "info", `Bot started on ${config.exchange} · ${config.symbol} ${config.timeframe}`);
    this.emitBot(config.id);
    if (bot.paused) {
      this.log(config.id, "warn", "Resumed with stale state (open position or counters) — trading is PAUSED pending confirmation.");
      await notify({ event: "error", bot: config.name, symbol: config.symbol, text: "Resumed with stale state — trading paused. Confirm to continue." });
    } else {
      await notify({ event: "start", bot: config.name, symbol: config.symbol, text: `Started on ${config.exchange} (${config.timeframe})` });
    }
  }

  /** Clear the paused flag set by the resume staleness gate and let the bot trade. */
  confirmResume(id: string): boolean {
    const bot = this.running.get(id);
    if (!bot?.paused) return false;
    bot.paused = false;
    this.log(id, "info", "Trading resumed by operator");
    void notify({ event: "start", bot: bot.config.name, symbol: bot.config.symbol, text: "Trading resumed by operator" });
    return true;
  }

  isPaused(id: string): boolean {
    return this.running.get(id)?.paused === true;
  }

  stop(id: string) {
    const bot = this.running.get(id);
    if (!bot) return;
    bot.sub?.close();
    if (bot.paper) this.persistPaper(bot);
    this.persistState(bot);
    this.running.delete(id);
    bot.config.status = "stopped";
    bot.config.updatedAt = Date.now();
    upsertBot(bot.config);
    this.log(id, "info", "Bot stopped");
    this.emitBot(id);
    void notify({ event: "stop", bot: bot.config.name, symbol: bot.config.symbol, text: "Stopped" });
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  /**
   * Tear down runtime on process exit WITHOUT flipping desired status, so bots
   * whose status is "running" come back automatically on the next boot (resume).
   * Use stop()/stopAll() for an intentional stop that should persist.
   */
  shutdown() {
    for (const bot of this.running.values()) {
      bot.sub?.close();
      if (bot.paper) this.persistPaper(bot);
      this.persistState(bot);
    }
    this.running.clear();
  }

  /** Restart bots that were running before the process stopped (called on boot). */
  async resume() {
    for (const config of listBots()) {
      if (config.status !== "running" || this.running.has(config.id)) continue;
      try {
        // Bypass the collision guard on resume — these were legitimately running.
        await this.start(config, { override: true, resumed: true });
        this.log(config.id, "info", "Resumed after restart");
      } catch (error) {
        this.log(config.id, "error", `Resume failed: ${error instanceof Error ? error.message : error}`);
        config.status = "stopped";
        upsertBot(config);
      }
    }
  }

  /** Realized PnL booked so far in the current UTC day, for the daily-loss guard. */
  private realizedToday(botId: string): number {
    const startOfDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    return listFills(botId, 500)
      .filter((fill) => fill.ts >= startOfDay)
      .reduce((sum, fill) => sum + fill.realizedPnl, 0);
  }

  async orders(id: string) {
    const bot = this.running.get(id);
    return bot?.adapter.orders ? bot.adapter.orders(bot.config.symbol) : [];
  }

  /**
   * Cross-bot portfolio snapshot. Live accounts (id !== "paper") are deduped by
   * exchange+market so two bots on one account aren't double-counted; each
   * account's equity/positions/open-orders are read once. Paper bots are kept
   * separate (isolated sims). Every adapter call is guarded so one failing
   * exchange degrades to an `error` field instead of breaking the response.
   */
  async portfolio(): Promise<PortfolioSummary> {
    const realizedTodayByBot: Record<string, number> = {};
    let totalRealizedToday = 0;
    const paper: PortfolioSummary["paper"] = [];

    // Group running live bots by exchange+market; collect their symbols.
    const groups = new Map<string, { adapter: ExchangeAdapter; symbols: Set<string> }>();

    for (const bot of this.running.values()) {
      const realized = this.realizedToday(bot.config.id);
      realizedTodayByBot[bot.config.id] = realized;
      totalRealizedToday += realized;

      if (bot.adapter.id === "paper") {
        const state = bot.paper?.getState();
        paper.push({
          botId: bot.config.id,
          name: bot.config.name,
          symbol: bot.config.symbol,
          equity: (await bot.adapter.account().catch(() => undefined))?.equity ?? state?.balance ?? 0,
          balance: state?.balance ?? 0,
          position: state?.position ?? null,
          openOrders: state?.orders ?? []
        });
        continue;
      }

      const key = `${bot.adapter.id}:${bot.adapter.market}`;
      const group = groups.get(key) ?? { adapter: bot.adapter, symbols: new Set<string>() };
      group.symbols.add(bot.config.symbol);
      groups.set(key, group);
    }

    const exchanges: PortfolioExchange[] = [];
    for (const [id, group] of groups) {
      const entry: PortfolioExchange = {
        id,
        exchange: group.adapter.id,
        market: group.adapter.market,
        equity: 0,
        balance: 0,
        currency: "USDT",
        positions: [],
        openOrders: []
      };
      try {
        const account = await group.adapter.account();
        entry.equity = account.equity;
        entry.balance = account.balance;
        entry.currency = account.currency;
      } catch (error) {
        entry.error = error instanceof Error ? error.message : "account read failed";
      }
      // One position + open-order read per traded symbol on this account.
      for (const symbol of group.symbols) {
        try {
          const pos = await group.adapter.position(symbol);
          if (pos) entry.positions.push(pos);
        } catch {
          // A single symbol failing shouldn't drop the whole account.
        }
        try {
          if (group.adapter.orders) entry.openOrders.push(...(await group.adapter.orders(symbol)));
        } catch {
          // Ignore open-order read failure for this symbol.
        }
      }
      exchanges.push(entry);
    }

    return { exchanges, realizedTodayByBot, totalRealizedToday, paper };
  }

  /**
   * Execute a raw Antares message set (chained commands with pauses).
   * With `dryRun`, nothing is sent to the exchange — each command is parsed and
   * echoed back as a resolved order so the operator can preview it first.
   */
  async manualCommand(id: string, input: string, dryRun = false): Promise<{ ok: boolean; message: string }> {
    const bot = this.running.get(id);
    if (!bot) return { ok: false, message: "Bot is not running" };
    try {
      const steps = parseMessageSet(input);
      const messages: string[] = [];
      for (const step of steps) {
        if (step.command) {
          const exec = commandToExec(step.command);
          if (!exec.symbol) exec.symbol = bot.config.symbol;
          if (dryRun) {
            messages.push(`would ${formatExec(exec)}`);
            continue;
          }
          const result = await bot.adapter.execute(exec);
          this.applyResult(bot, result, exec.reason);
          messages.push(result.message);
        }
        if (!dryRun && step.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(step.delayMs, 10_000)));
      }
      return { ok: true, message: (dryRun ? "Dry run — " : "") + (messages.join(" · ") || "Done") };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Command failed" };
    }
  }

  // ---------- stream handling ----------

  private onCandle(id: string, candle: Candle) {
    const bot = this.running.get(id);
    if (!bot) return;
    bot.price = candle.close;

    // Fill any resting limit / stop / take-profit orders crossed by this tick.
    if (bot.adapter.onPrice) {
      const fills = bot.adapter.onPrice(bot.config.symbol, candle.close);
      for (const fill of fills) {
        insertFill(fill);
        this.log(bot.config.id, "info", `Order ${fill.kind} ${fill.qty} @ ${fill.price}${fill.kind === "close" ? ` · PnL ${round(fill.realizedPnl)}` : ""}`);
        this.broadcast({ type: "fill", botId: bot.config.id, fill });
        if (fill.kind === "close") void notify({ event: "close", bot: bot.config.name, symbol: bot.config.symbol, text: `Order fill · PnL ${round(fill.realizedPnl)}` });
      }
      if (fills.length && bot.paper) this.persistPaper(bot);
    }

    const last = bot.buffer.at(-1);

    if (!last || candle.time === last.time) {
      if (last && candle.time === last.time) bot.buffer[bot.buffer.length - 1] = candle;
      else bot.buffer.push(candle);
      void this.onTick(bot, candle);
      return;
    }

    if (candle.time > last.time) {
      // `last` just closed — evaluate the strategy on it, then start the new bar.
      void this.onClosedBar(bot, bot.buffer.length - 1).finally(() => {
        bot.buffer.push(candle);
        if (bot.buffer.length > BUFFER_CAP) bot.buffer.shift();
      });
    }
  }

  /** Intrabar: trailing stop ratchet + stop / target hit checks. */
  private async onTick(bot: RunningBot, candle: Candle) {
    if (!bot.managed) return;
    const m = bot.managed;
    if (m.trail) {
      const atr = m.trail.mode === "atr" ? atrValue(bot.buffer, 14, bot.buffer.length - 1) || 0 : 0;
      if (m.side === "long") {
        const candidate = m.trail.mode === "percent" ? candle.high * (1 - m.trail.value / 100) : candle.high - atr * m.trail.value;
        m.stop = Math.max(m.stop ?? -Infinity, candidate);
      } else {
        const candidate = m.trail.mode === "percent" ? candle.low * (1 + m.trail.value / 100) : candle.low + atr * m.trail.value;
        m.stop = Math.min(m.stop ?? Infinity, candidate);
      }
    }
    const stopHit = m.stop !== undefined && (m.side === "long" ? candle.low <= m.stop : candle.high >= m.stop);
    const targetHit = m.target !== undefined && (m.side === "long" ? candle.high >= m.target : candle.low <= m.target);
    if (stopHit) await this.closePosition(bot, "stop");
    else if (targetHit) await this.closePosition(bot, "target");
  }

  private async onClosedBar(bot: RunningBot, index: number) {
    // Auto-resumed with stale risky state: buffer only, don't trade, until confirmed.
    if (bot.paused) return;
    let intents: BarIntents;
    try {
      intents = evaluateBar(bot.config.ir, bot.buffer, index, bot.vars, this.positionCtx(bot));
    } catch (error) {
      this.log(bot.config.id, "error", `Strategy error: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (intents.budgetExceeded) {
      this.log(bot.config.id, "warn", "Per-bar execution budget hit — a loop was truncated this bar.");
    }

    for (const marker of intents.markers) {
      this.broadcast({ type: "signal", botId: bot.config.id, signal: { dir: marker.dir, label: marker.label, price: bot.price, ts: Date.now() } });
      if (bot.config.notifyMarkers) {
        void notify({ event: "signal", bot: bot.config.name, symbol: bot.config.symbol, text: `Signal ${marker.dir === "up" ? "▲" : "▼"} ${marker.label} @ ${bot.price}` });
      }
    }
    for (const alert of intents.alerts) {
      this.log(bot.config.id, "info", `Alert: ${alert.message}`);
      void notify({ event: "signal", bot: bot.config.name, symbol: bot.config.symbol, text: alert.message });
    }

    if (bot.managed && intents.exit) {
      await this.closePosition(bot, "signal");
    } else if (!bot.managed && intents.entry) {
      await this.openPosition(bot, intents, index);
    }
    // Persist counters + managed state every closed bar so a crash can't reset them.
    this.persistState(bot);
  }

  // ---------- position actions ----------

  private async openPosition(bot: RunningBot, intents: BarIntents, index: number) {
    const dir = intents.entry!;
    const price = bot.price;
    const isLive = bot.adapter.id !== "paper";

    // Daily-loss circuit breaker: stop the bot for the day once the cap is hit.
    const dailyCap = bot.config.maxDailyLossQuote ?? 0;
    if (dailyCap > 0 && this.realizedToday(bot.config.id) <= -dailyCap) {
      this.log(bot.config.id, "warn", `Daily loss limit (${dailyCap}) reached — stopping bot`);
      void notify({ event: "error", bot: bot.config.name, symbol: bot.config.symbol, text: `Daily loss limit reached — bot stopped` });
      this.stop(bot.config.id);
      return;
    }

    const account = await bot.adapter.account().catch(() => ({ balance: 0, equity: 0, currency: "USDT" }));
    const equity = account.equity || bot.config.sizeValue;
    const atr = atrValue(bot.buffer, 14, index) || 0;

    const stop = this.resolvePrice(intents.stop, dir, price, atr);
    const target = this.resolveTarget(intents.target, dir, price, atr);
    let qty = this.resolveQty(bot, intents, price, equity, stop);
    if (!qty || qty <= 0) {
      this.log(bot.config.id, "warn", "Entry skipped — computed size is zero");
      return;
    }

    // Cap notional exposure per the bot's risk limit.
    const notionalCap = bot.config.maxPositionQuote ?? 0;
    if (notionalCap > 0 && qty * price > notionalCap) {
      const capped = notionalCap / price;
      this.log(bot.config.id, "warn", `Size capped to ${notionalCap} quote (was ${round(qty * price)})`);
      qty = capped;
    }

    // For a live futures entry without a trailing stop, place the protective
    // stop/target ON THE EXCHANGE so the position survives a crash/disconnect.
    // Otherwise the engine manages stop/target/trailing locally (intrabar).
    const exchangeManaged = isLive && bot.config.market === "futures" && !intents.trail && (stop !== undefined || target !== undefined);

    const order: ExecOrder = {
      action: bot.config.market === "spot" ? "neworder" : "open",
      market: bot.config.market,
      symbol: bot.config.symbol,
      side: dir === "long" ? "buy" : "sell",
      type: "market",
      qty,
      leverage: bot.config.leverage,
      clientId: `${bot.config.id.slice(0, 8)}-o-${bot.buffer.at(-1)?.time ?? Date.now()}`,
      reason: "signal:entry"
    };
    if (exchangeManaged) {
      if (stop !== undefined) order.stop = { basis: "price", value: stop };
      if (target !== undefined) order.takeProfits = [{ priceBasis: "price", price: target, qtyBasis: "percent", qty: 100 }];
    }

    const result = await bot.adapter.execute(order);
    if (result.ok) {
      // When the exchange holds the SL/TP, don't also manage them locally (avoids double-close).
      const entryTime = bot.buffer[index]?.time ?? bot.buffer.at(-1)?.time ?? 0;
      bot.managed = exchangeManaged
        ? { side: dir, entry: bot.price, qty, entryTime }
        : { side: dir, entry: bot.price, qty, entryTime, stop, target, trail: intents.trail };
      this.persistState(bot);
    } else {
      this.log(bot.config.id, "error", `Open failed: ${result.message}`);
    }
    this.applyResult(bot, result, "signal:entry");
    if (result.ok) {
      await notify({ event: "open", bot: bot.config.name, symbol: bot.config.symbol, text: `Opened ${dir.toUpperCase()} ${round(qty)} @ ${round(price)}${stop ? ` · SL ${round(stop)}` : ""}${target ? ` · TP ${round(target)}` : ""}` });
    }
  }

  private async closePosition(bot: RunningBot, reason: "signal" | "stop" | "target") {
    if (!bot.managed) return;
    const order: ExecOrder = {
      action: bot.config.market === "spot" ? "neworder" : "close",
      market: bot.config.market,
      symbol: bot.config.symbol,
      side: bot.managed.side === "long" ? "sell" : "buy",
      type: "market",
      closePct: 100,
      reduceOnly: true,
      clientId: `${bot.config.id.slice(0, 8)}-c-${bot.buffer.at(-1)?.time ?? Date.now()}`,
      reason: `signal:${reason}`
    };
    const result = await bot.adapter.execute(order);
    this.applyResult(bot, result, `signal:${reason}`);
    if (result.ok) {
      const pnl = result.fills.reduce((sum, f) => sum + f.realizedPnl, 0);
      bot.managed = undefined;
      this.persistState(bot);
      await notify({ event: "close", bot: bot.config.name, symbol: bot.config.symbol, text: `Closed (${reason}) · PnL ${round(pnl)}` });
    } else {
      this.log(bot.config.id, "error", `Close failed: ${result.message}`);
    }
  }

  private applyResult(bot: RunningBot, result: ExecResult, _reason: string) {
    for (const fill of result.fills) {
      insertFill(fill);
      this.broadcast({ type: "fill", botId: bot.config.id, fill, account: result.account, position: result.position });
    }
    if (result.message) this.log(bot.config.id, result.ok ? "info" : "error", result.message);
    if (bot.paper) this.persistPaper(bot);
    if (result.account || result.position !== undefined) {
      this.broadcast({ type: "bot", botId: bot.config.id, account: result.account, position: result.position });
    }
  }

  // ---------- helpers ----------

  private resolveQty(bot: RunningBot, intents: BarIntents, price: number, equity: number, stop?: number): number {
    const size = intents.size ?? { mode: mapSizeMode(bot.config.sizeMode), value: bot.config.sizeValue };
    const lev = Math.max(1, bot.config.leverage);
    switch (size.mode) {
      case "units":
        return bot.config.sizeMode === "quote" && !intents.size ? size.value / price : size.value;
      case "equity_pct":
        return (equity * (size.value / 100) * lev) / price;
      case "risk_pct": {
        if (stop && Math.abs(price - stop) > 0) return (equity * (size.value / 100)) / Math.abs(price - stop);
        return (equity * lev) / price;
      }
      default:
        return size.value;
    }
  }

  private resolvePrice(stop: BarIntents["stop"], dir: "long" | "short", entry: number, atr: number): number | undefined {
    if (!stop) return undefined;
    if (stop.mode === "price") return stop.value;
    if (stop.mode === "percent") return dir === "long" ? entry * (1 - stop.value / 100) : entry * (1 + stop.value / 100);
    return dir === "long" ? entry - atr * stop.value : entry + atr * stop.value;
  }

  private resolveTarget(target: BarIntents["target"], dir: "long" | "short", entry: number, atr: number): number | undefined {
    if (!target) return undefined;
    if (target.mode === "price") return target.value;
    if (target.mode === "percent") return dir === "long" ? entry * (1 + target.value / 100) : entry * (1 - target.value / 100);
    return dir === "long" ? entry + atr * target.value : entry - atr * target.value;
  }

  private buildAdapter(config: BotConfig, getPrice: () => number): ExchangeAdapter {
    if (config.exchange === "binance" || config.exchange === "bybit") {
      const keys = getSetting<ExchangeKeys>(`keys:${config.exchange}`) ?? { apiKey: "", apiSecret: "" };
      return config.exchange === "binance"
        ? new BinanceAdapter(config.id, keys, config.market)
        : new BybitAdapter(config.id, keys, config.market);
    }
    return new PaperAdapter({
      botId: config.id,
      market: config.market,
      startBalance: config.sizeMode === "quote" ? Math.max(config.sizeValue * 10, 10_000) : 10_000,
      feePct: 0.05,
      slipPct: 0.02,
      getPrice: () => getPrice()
    });
  }

  private persistPaper(bot: RunningBot) {
    if (!bot.paper) return;
    setSetting(`paper:${bot.config.id}`, bot.paper.getState());
  }

  /** Build the per-bar position/PnL context for `ctx` reads (flat → {} → all 0). */
  private positionCtx(bot: RunningBot): Record<string, number> {
    const m = bot.managed;
    if (!m) return {};
    const price = bot.price;
    const move = m.side === "long" ? price - m.entry : m.entry - price;
    const tf = timeframeMs[bot.config.timeframe] ?? 60_000;
    const lastBarTime = bot.buffer.at(-1)?.time ?? m.entryTime ?? 0;
    return {
      position_dir: m.side === "long" ? 1 : -1,
      entry_price: m.entry,
      unrealized_pnl: (m.qty ?? 0) * move,
      unrealized_pnl_pct: m.entry ? (move / m.entry) * 100 : 0,
      bars_in_position: Math.max(0, Math.round((lastBarTime - (m.entryTime ?? lastBarTime)) / tf))
    };
  }

  /** Persist durable strategy state (setvar counters + managed position) for crash recovery. */
  private persistState(bot: RunningBot) {
    const snapshot: BotStateSnapshot = {
      vars: Object.fromEntries(bot.vars),
      managed: bot.managed,
      lastBarTime: bot.buffer.at(-1)?.time ?? 0,
      savedAt: Date.now()
    };
    setSetting(`state:${bot.config.id}`, snapshot);
  }

  private log(botId: string, level: "info" | "warn" | "error", message: string) {
    const ts = Date.now();
    insertLog({ botId, level, message, ts });
    this.broadcast({ type: "log", botId, log: { level, message, ts } });
  }

  private emitBot(id: string) {
    const bot = this.running.get(id);
    this.broadcast({ type: "bot", botId: id, bot: bot?.config });
  }
}

function mapSizeMode(mode: BotConfig["sizeMode"]): "units" | "equity_pct" | "risk_pct" {
  if (mode === "equity_pct") return "equity_pct";
  if (mode === "risk_pct") return "risk_pct";
  return "units";
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
