import type { Candle, Instrument, Timeframe } from "../types.js";
import { findInstrument } from "../market/catalog.js";
import { timeframeMs } from "../market/timeframes.js";
import { ProviderRouter } from "../providers/router.js";
import { findLiveCollision } from "./collision.js";
import { resolvePositionQty, resolveStopPrice, resolveTargetPrice } from "./engineRisk.js";
import { atrValue, evaluateBar, runInit, type BarIntents } from "./strategy/evaluator.js";
import { PaperAdapter } from "./exchange/paper.js";
import { notify } from "./notifications.js";
import { classifyCandleSequence } from "./candleSequence.js";
import { getSetting, insertLog, listOrderJournal, setSetting } from "./store.js";
import { restorePaperTrading } from "./paperRecovery.js";
import type { Managed, BotStateSnapshot, RunningBot } from "./engineRuntime.js";
import { EngineOrderCoordinator } from "./engineOrderCoordinator.js";
import type { EmergencyStopOptions } from "./emergencyStop.js";
import { buildPortfolioSummary } from "./enginePortfolio.js";
import { buildEmergencyAdapters, buildEngineAdapter, engineMarketRoute } from "./engineAdapters.js";
import { clearPausedRuntime, equityOf, liveRuntimeState, pauseRunningBot, persistRuntimeState, positionContext, realizedToday, roundTradingValue as round } from "./engineState.js";
import { pauseBotRuntime } from "./enginePause.js";
import { persistBotRuntimeStatus } from "./botRuntimePersistence.js";
import { assertBotExecutionBinding } from "./botExecutionBinding.js";
import { persistClosedPaperMark } from "./paperPortfolioMarkRuntime.js";
import { getSpotInventory, liveSpotInventoryEnabled, resolveSpotCloseQuantity } from "./spotInventory.js";
import { assertLiveRiskReady, preflightLiveOrder } from "./liveRisk.js";
import { KeyedExclusiveLock } from "./keyedExclusiveLock.js";
import { runManualCommandSet } from "./manualCommandRunner.js";
import { loadLiveRiskJournal } from "./liveRiskReservations.js";
import { getFuturesExposure } from "./futuresExposure.js";
import { applyEngineResult } from "./engineResultAccounting.js";
import { applySynchronousReduceOnlyExecution, pausedOrderAllowed } from "./managedExecution.js";
import { executeDurableEngineOrder } from "./durableEngineExecution.js";
import type { TradeEvent } from "./engineEvents.js";
import { EngineStopCoordinator, engineOrderLockKey } from "./engineStopCoordinator.js";
import { applyPriceTriggeredFills } from "./enginePriceEvents.js";
import type { BotConfig, ExchangeAdapter, ExecOrder, ExecResult, PortfolioSummary } from "./types.js";
import { botTradingAccountId } from "./tradingAccounts.js";
import { botBelongsToOwner, tradingOwnerForBot } from "./ownership.js";
import { EngineTenantRuntime } from "./engineTenantRuntime.js";
import { resumePersistedBots, type ResumeAuthorization } from "./engineResume.js";
import type { TradingResourceLimits } from "./resourceQuotas.js";
import { assertLiveExecutionAllowed, assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../runtimeProfile.js";
const BUFFER_CAP = 1500;
const SEED_BARS = 500;
type EngineStartOptions = { override?: boolean; resumed?: boolean; preflight?: () => Promise<void>; validateCurrent?: () => void };
export class TradingEngine {
  private running = new Map<string, RunningBot>();
  private readonly botStartLock = new KeyedExclusiveLock();
  private readonly manualCommandLock = new KeyedExclusiveLock();
  private readonly orderExecutionLock = new KeyedExclusiveLock();
  private muted: Set<string>;
  private readonly orderCoordinator: EngineOrderCoordinator;
  private readonly stopCoordinator: EngineStopCoordinator;
  private readonly tenants: EngineTenantRuntime;
  constructor(private readonly provider: ProviderRouter, broadcast: (event: TradeEvent) => void, emergencyAdapters: (ownerUserId: string) => Iterable<ExchangeAdapter> = buildEmergencyAdapters, resourceLimits?: TradingResourceLimits, private readonly runtimePolicy: RuntimePolicy = getRuntimePolicy()) {
    this.muted = new Set(getSetting<string[]>("mutedBots") ?? []);
    const guardedEmergencyAdapters = (ownerUserId: string) => this.runtimePolicy.privateExchangeMutationsAllowed ? emergencyAdapters(ownerUserId) : [];
    this.tenants = new EngineTenantRuntime((id) => this.running.get(id), () => this.running.values(), (id) => this.stop(id), broadcast, guardedEmergencyAdapters, resourceLimits);
    this.orderCoordinator = new EngineOrderCoordinator(
      (id) => this.running.get(id),
      (botId, level, message) => this.log(botId, level, message),
      (event) => this.broadcastOwned(event),
      (bot, reason) => {
        pauseRunningBot(bot, reason);
        persistRuntimeState(bot);
      },
      (bot) => persistRuntimeState(bot)
    );
    this.stopCoordinator = new EngineStopCoordinator(
      {
        current: (id) => this.running.get(id),
        remove: (id) => {
          this.running.delete(id);
        },
        log: (id, message) => this.log(id, "info", message),
        emit: (id) => this.emitBot(id)
      },
      this.botStartLock,
      this.manualCommandLock,
      this.orderExecutionLock
    );
  }
  /** Mute/unmute a bot's alert & marker notifications (persisted). */
  setMuted(id: string, muted: boolean): void {
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
    setSetting("mutedBots", [...this.muted]);
  }
  isMuted(id: string): boolean { return this.muted.has(id); }
  emergencyStatus(ownerUserId = tradingOwnerForBot({})) { return this.emergencyForOwner(ownerUserId).status(); }
  emergencyStop(options?: EmergencyStopOptions) { return this.emergencyStopForOwner(tradingOwnerForBot({}), options); }
  async emergencyStopForOwner(ownerUserId: string, options?: EmergencyStopOptions) {
    this.tenants.invalidateOwnerStarts(ownerUserId);
    const operation = this.emergencyForOwner(ownerUserId).run(options);
    const [result] = await Promise.all([operation, this.tenants.drainOwner(ownerUserId, (id) => this.stopCoordinator.stopSafely(id))]);
    return result;
  }
  resetEmergencyAfterTerminal(ownerUserId = tradingOwnerForBot({})) { this.emergencyForOwner(ownerUserId).resetAfterTerminal(); }
  /** Flatten a running bot's open position without stopping the bot. */
  async closeNow(id: string): Promise<boolean> {
    const bot = this.running.get(id);
    if (!bot?.managed || this.stopCoordinator.isStopping(id)) return false;
    await this.closePosition(bot, "signal");
    return true;
  }
  isRunning(id: string) { return this.running.has(id); }
  isRunningForOwner(ownerUserId: string, id: string): boolean { return this.ownedRuntime(ownerUserId, id) !== undefined; }
  /** Configuration that owns the actual running adapter (authoritative for auth). */
  runtimeConfig(id: string): BotConfig | undefined {
    const config = this.running.get(id)?.config;
    return config ? structuredClone(config) : undefined;
  }
  runtimeConfigForOwner(ownerUserId: string, id: string): BotConfig | undefined {
    const config = this.ownedRuntime(ownerUserId, id)?.config;
    return config ? structuredClone(config) : undefined;
  }
  async liveState(id: string) { const bot = this.running.get(id); return bot ? liveRuntimeState(bot) : null; }
  async liveStateForOwner(ownerUserId: string, id: string) { const bot = this.ownedRuntime(ownerUserId, id); return bot ? liveRuntimeState(bot) : null; }
  liveCollision(config: BotConfig): BotConfig | undefined {
    const ownerUserId = tradingOwnerForBot(config);
    return findLiveCollision(
      config,
      [...this.running.values()].map((bot) => bot.config).filter((candidate) => tradingOwnerForBot(candidate) === ownerUserId)
    );
  }
  async start(config: BotConfig, options: EngineStartOptions = {}) {
    if (config.exchange !== "paper") assertLiveExecutionAllowed("live bot start", this.runtimePolicy);
    if (config.exchange !== "paper" && !config.ownerUserId?.trim()) {
      throw new Error("Live bot owner is missing; refusing to access trading credentials.");
    }
    config.ownerUserId = tradingOwnerForBot(config);
    assertBotExecutionBinding(config);
    this.tenants.remember(config);
    const lease = this.tenants.beginStart(config.ownerUserId, config.id);
    const accountId = config.exchange === "paper" ? undefined : botTradingAccountId(config);
    return this.tenants.runStart(lease, accountId, config.exchange, () => this.botStartLock.run(config.id, () => this.startUnlocked(config, options, () => { lease.assertCurrent(); options.validateCurrent?.(); })), options.validateCurrent);
  }
  async startForOwner(ownerUserId: string, config: BotConfig, options: EngineStartOptions = {}) {
    if (!botBelongsToOwner(config, ownerUserId)) throw new Error("Bot not found");
    return this.start(config, options);
  }
  private async startUnlocked(config: BotConfig, options: EngineStartOptions, assertStartCurrent: () => void) {
    assertStartCurrent();
    if (this.running.has(config.id)) return;
    if (config.exchange !== "paper") this.emergencyForOwner(tradingOwnerForBot(config)).assertLiveStartAllowed();
    const instrument = findInstrument(config.symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${config.symbol}`);
    if (config.exchange !== "paper") {
      assertLiveRiskReady(config);
      if (instrument.provider !== "binance") {
        throw new Error(`Live trading requires a real exchange feed for ${config.symbol}`);
      }
      if (config.market === "spot" && !liveSpotInventoryEnabled()) {
        throw new Error("Live spot trading is disabled until the spot inventory model is enabled.");
      }
    }
    // Guard against two live bots fighting over one exchange+symbol.
    const clash = this.liveCollision(config);
    if (clash && (config.exchange !== "paper" || !options.override)) {
      throw new Error(`A live bot is already running on ${config.exchange} ${config.symbol} ("${clash.name}"). Stop it before starting another bot on the same account instrument.`);
    }
    if (options.preflight) {
      await options.preflight();
      assertStartCurrent();
    }
    const adapter = buildEngineAdapter(config, () => this.running.get(config.id)?.price ?? 0, this.runtimePolicy);
    const bot: RunningBot = { config, adapter, instrument, buffer: [], price: 0, vars: new Map(), eventQueue: Promise.resolve() };
    if (adapter instanceof PaperAdapter) {
      bot.paper = adapter;
      restorePaperTrading(config.id, config.paperLedgerEpoch ?? 1, adapter);
    }

    const savedState = getSetting<BotStateSnapshot>(`state:${config.id}`);
    let persistAfterSeed = false;
    if (savedState) {
      for (const [name, value] of Object.entries(savedState.vars ?? {})) bot.vars.set(name, value);
      bot.managed = savedState.managed;
      bot.paused = savedState.paused === true;
      bot.pauseReason = savedState.pauseReason;
      const hasRisk = !!bot.managed || Object.values(savedState.vars ?? {}).some((v) => v !== 0);
      const gap = Date.now() - (savedState.lastBarTime || 0);
      const stale = gap > 3 * (timeframeMs[config.timeframe] ?? 60_000);
      if (options.resumed && hasRisk && stale) pauseRunningBot(bot, "Resumed with stale state (open position or nonzero counters) pending operator confirmation.");
    }

    const hasPriorLifecycle = savedState !== undefined || listOrderJournal(config.id, 1).length > 0;
    if (config.exchange !== "paper" && (options.resumed || hasPriorLifecycle)) {
      persistAfterSeed = await this.orderCoordinator.reconcileOnResume(bot, savedState?.managed);
      assertStartCurrent();
    }

    const strict = config.exchange !== "paper";
    const route = engineMarketRoute(config);

    const seed = await this.provider.getCandles(instrument, config.timeframe, { limit: SEED_BARS }, { ...route, strict });
    assertStartCurrent();
    bot.buffer = seed.slice(-BUFFER_CAP);
    bot.price = bot.buffer.at(-1)?.close ?? 0;
    if (persistAfterSeed || bot.paused) persistRuntimeState(bot);

    if (!savedState) runInit(config.ir, bot.buffer, bot.vars);

    const subscription = await this.provider.subscribeMarket(
      instrument,
      config.timeframe,
      ({ candle }) => this.onCandle(config.id, candle),
      (message) => this.log(config.id, message.toLowerCase().includes("error") || message.toLowerCase().includes("closed") ? "warn" : "info", message),
      { ...route, strict }
    );
    try {
      assertStartCurrent();
      bot.sub = subscription;
      persistBotRuntimeStatus(config, "running");
    } catch (error) {
      subscription.close();
      bot.sub = undefined;
      throw error;
    }

    this.running.set(config.id, bot);
    this.orderCoordinator.startOrderPolling(bot);
    this.orderCoordinator.startPrivateOrderStream(bot);
    this.log(config.id, "info", `Bot started on ${config.exchange} · ${config.symbol} ${config.timeframe}`);
    this.emitBot(config.id);
    if (bot.paused) {
      this.log(config.id, "warn", `${bot.pauseReason ?? "Trading is paused pending operator confirmation."}`);
      void notify({ ownerUserId: tradingOwnerForBot(config), event: "error", bot: config.name, symbol: config.symbol, text: `${bot.pauseReason ?? "Trading paused."} Confirm to continue.` }).catch(() => undefined);
    } else {
      void notify({ ownerUserId: tradingOwnerForBot(config), event: "start", bot: config.name, symbol: config.symbol, text: `Started on ${config.exchange} (${config.timeframe})` }).catch(() => undefined);
    }
  }

  /** Reconcile fresh live state before clearing a fail-closed pause. */
  async confirmResume(id: string, validateCurrent?: () => boolean): Promise<boolean> {
    const bot = this.running.get(id);
    if (!bot?.paused) return false;
    let confirmed = false;
    bot.eventQueue = bot.eventQueue.then(async () => {
      if (this.running.get(id) !== bot || !bot.paused) return;
      if (validateCurrent && !validateCurrent()) return;
      confirmed = bot.config.exchange === "paper" ? clearPausedRuntime(bot) : await this.orderCoordinator.confirmResume(bot, validateCurrent);
    });
    await bot.eventQueue;
    if (!confirmed) return false;
    this.log(id, "info", "Trading resumed by operator");
    void notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "start", bot: bot.config.name, symbol: bot.config.symbol, text: "Trading resumed by operator" });
    return true;
  }

  async confirmResumeForOwner(ownerUserId: string, id: string, validateCurrent?: () => boolean): Promise<boolean> { return this.ownedRuntime(ownerUserId, id) ? this.confirmResume(id, validateCurrent) : false; }
  isPaused(id: string): boolean { return this.running.get(id)?.paused === true; }
  isPausedForOwner(ownerUserId: string, id: string): boolean { return this.ownedRuntime(ownerUserId, id)?.paused === true; }
  async pauseForOwner(ownerUserId: string, id: string): Promise<boolean> {
    const bot = this.ownedRuntime(ownerUserId, id);
    return bot ? pauseBotRuntime(
      bot, () => this.running.get(id) === bot,
      (message) => this.log(id, "info", message), () => this.emitBot(id)
    ) : false;
  }
  stop(id: string) { this.stopCoordinator.stopNow(id); }
  async stopSafely(id: string): Promise<void> { await this.stopCoordinator.stopSafely(id); }
  async stopSafelyForOwner(ownerUserId: string, id: string): Promise<void> {
    if (!this.tenants.knows(ownerUserId, id)) return;
    await this.tenants.withBotLifecycleLock(ownerUserId, id, () => this.stopCoordinator.stopSafely(id));
  }

  async stopOwnerSafely(ownerUserId: string): Promise<number> {
    return this.tenants.drainOwner(ownerUserId, (id) => this.stopCoordinator.stopSafely(id), true);
  }

  resumeOwnerStarts(ownerUserId: string): void { this.tenants.resumeOwnerStarts(ownerUserId); }
  withBotLifecycleLock<T>(ownerUserId: string, botId: string, operation: () => Promise<T>): Promise<T> { return this.tenants.withBotLifecycleLock(ownerUserId, botId, operation); }
  withAccountLifecycleLock<T>(ownerUserId: string, accountId: string, operation: () => Promise<T>): Promise<T> {
    return this.tenants.withAccountLifecycleLock(ownerUserId, accountId, operation);
  }
  deleteSafelyForOwner<T>(ownerUserId: string, id: string, remove: () => T | Promise<T>): Promise<T> {
    return this.tenants.deleteBot(ownerUserId, id, () => this.stopCoordinator.stopSafely(id), remove);
  }

  stopAll() { for (const id of [...this.running.keys()]) this.stop(id); }

  shutdown() { this.stopCoordinator.shutdown(this.running.values()); }

  /** Restart only bots whose owner still has the required role at boot. */
  async resume(authorize: ResumeAuthorization = () => true) {
    await resumePersistedBots({ authorize, isRunning: (id) => this.running.has(id), start: (config) => this.start(config, { override: true, resumed: true }), log: (id, level, message) => this.log(id, level, message) });
  }

  async orders(id: string) { const bot = this.running.get(id); return bot?.adapter.orders ? bot.adapter.orders(bot.config.symbol) : []; }
  async ordersForOwner(ownerUserId: string, id: string) { const bot = this.ownedRuntime(ownerUserId, id); return bot?.adapter.orders ? bot.adapter.orders(bot.config.symbol) : []; }

  /** Legacy runtime-only cross-bot snapshot; R4 paper portfolios use the durable projector. */
  async portfolio(ownerUserId = tradingOwnerForBot({})): Promise<PortfolioSummary> {
    const owned = [...this.running.values()].filter((bot) => botBelongsToOwner(bot.config, ownerUserId));
    return buildPortfolioSummary(owned, (botId) => realizedToday(botId));
  }

  /** Execute a raw Antares message set; dry-run parses without exchange I/O. */
  async manualCommand(id: string, input: string, dryRun = false, authorize?: (order: ExecOrder) => boolean): Promise<{ ok: boolean; message: string }> {
    const bot = this.running.get(id);
    if (!bot || this.stopCoordinator.isStopping(id)) return { ok: false, message: "Bot is not running" };
    return this.manualCommandLock.run(id, async () => {
      if (this.running.get(id) !== bot || this.stopCoordinator.isStopping(id)) return { ok: false, message: "Bot is not running" };
      return runManualCommandSet({
        bot,
        input,
        dryRun,
        authorize,
        execute: (order) => this.executeOrder(bot, order),
        applyResult: (result, reason, order) => this.applyResult(bot, result, reason, order)
      });
    });
  }

  async manualCommandForOwner(ownerUserId: string, id: string, input: string, dryRun = false, authorize?: (order: ExecOrder) => boolean): Promise<{ ok: boolean; message: string }> {
    return this.ownedRuntime(ownerUserId, id) ? this.manualCommand(id, input, dryRun, authorize) : { ok: false, message: "Bot is not running" };
  }

  private onCandle(id: string, candle: Candle) {
    const bot = this.running.get(id);
    if (!bot) return;
    bot.eventQueue = bot.eventQueue.then(() => this.handleCandle(bot, candle)).catch((error) => this.log(id, "error", `Market event failed: ${error instanceof Error ? error.message : error}`));
  }

  private async handleCandle(bot: RunningBot, candle: Candle) {
    const last = bot.buffer.at(-1);
    const sequence = classifyCandleSequence(last?.time, candle.time, timeframeMs[bot.config.timeframe] ?? 60_000);
    if (sequence.kind === "stale") {
      this.log(bot.config.id, "warn", `Ignored stale candle ${candle.time}; latest is ${last?.time} (${sequence.lagMs}ms behind).`);
      return;
    }
    if (sequence.kind === "gap") {
      this.log(bot.config.id, "warn", `Market-data gap before ${candle.time}: ${sequence.missingBars} interval(s) missing.`);
    }
    bot.price = candle.close;

    applyPriceTriggeredFills(bot, candle.close, {
      log: (message) => this.log(bot.config.id, "info", message),
      broadcast: (fill) => this.broadcastOwned({ type: "fill", botId: bot.config.id, fill })
    });

    if (!last || candle.time === last.time) {
      if (last && candle.time === last.time) bot.buffer[bot.buffer.length - 1] = candle;
      else bot.buffer.push(candle);
      await this.onTick(bot, candle);
      return;
    }

    if (candle.time > last.time) {
      // `last` just closed — evaluate the strategy on it, then start the new bar.
      await this.onClosedBar(bot, bot.buffer.length - 1);
      bot.buffer.push(candle);
      if (bot.buffer.length > BUFFER_CAP) bot.buffer.shift();
    }
  }

  /** Intrabar: trailing stop ratchet + stop / target hit checks. */
  private async onTick(bot: RunningBot, candle: Candle) {
    if (bot.paused || this.stopCoordinator.isStopping(bot.config.id) || !bot.managed) return;
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
    const closed = bot.buffer[index];
    const barTime = closed?.time;
    if (barTime !== undefined && bot.lastEvaluatedBarTime === barTime) return;
    if (bot.paper && closed && !persistClosedPaperMark(bot, closed, (message) => this.log(bot.config.id, "error", message))) return;
    if (bot.paused || this.stopCoordinator.isStopping(bot.config.id)) return;
    if (barTime !== undefined) bot.lastEvaluatedBarTime = barTime;
    let intents: BarIntents;
    const equity = await equityOf(bot);
    try {
      intents = evaluateBar(bot.config.ir, bot.buffer, index, bot.vars, positionContext(bot, equity));
    } catch (error) {
      this.log(bot.config.id, "error", `Strategy error: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (intents.budgetExceeded) {
      this.log(bot.config.id, "warn", "Per-bar execution budget hit — a loop was truncated this bar.");
    }

    const muted = this.muted.has(bot.config.id);
    for (const marker of intents.markers) {
      this.broadcastOwned({ type: "signal", botId: bot.config.id, signal: { dir: marker.dir, label: marker.label, price: bot.price, ts: Date.now() } });
      if (bot.config.notifyMarkers && !muted) {
        void notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "signal", bot: bot.config.name, symbol: bot.config.symbol, text: `Signal ${marker.dir === "up" ? "▲" : "▼"} ${marker.label} @ ${bot.price}` });
      }
    }
    for (const alert of intents.alerts) {
      this.log(bot.config.id, "info", `Alert: ${alert.message}`);
      if (!muted) void notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "signal", bot: bot.config.name, symbol: bot.config.symbol, text: alert.message });
    }

    if (bot.managed && intents.exit) {
      await this.closePosition(bot, "signal");
    } else if (!bot.managed && intents.entry) {
      await this.openPosition(bot, intents, index);
    }
    // Persist counters + managed state every closed bar so a crash can't reset them.
    persistRuntimeState(bot);
  }

  private async openPosition(bot: RunningBot, intents: BarIntents, index: number) {
    if (bot.orderInFlight) {
      this.log(bot.config.id, "warn", "Entry skipped — another exchange order is still in flight");
      return;
    }
    bot.orderInFlight = true;
    const dir = intents.entry!;
    try {
      const price = bot.price;
      const isLive = bot.adapter.id !== "paper";

      // Daily-loss circuit breaker: stop the bot for the day once the cap is hit.
      const dailyCap = bot.config.maxDailyLossQuote ?? 0;
      if (dailyCap > 0 && realizedToday(bot.config.id) <= -dailyCap) {
        this.log(bot.config.id, "warn", `Daily loss limit (${dailyCap}) reached — stopping bot`);
        void notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "error", bot: bot.config.name, symbol: bot.config.symbol, text: `Daily loss limit reached — bot stopped` });
        this.stop(bot.config.id);
        return;
      }

      const account = await bot.adapter.account().catch(() => ({ balance: 0, equity: 0, currency: "USDT" }));
      const equity = account.equity || bot.config.sizeValue;
      const atr = atrValue(bot.buffer, 14, index) || 0;

      const stop = resolveStopPrice(intents.stop, dir, price, atr);
      const target = resolveTargetPrice(intents.target, dir, price, atr);
      let qty = resolvePositionQty(bot.config, intents, price, equity, stop);
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

      // Prefer exchange-held futures protection when no local trailing stop is required.
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

      const result = await this.executeOrder(bot, order, bot.buffer.at(-1)?.time);
      const protectionConfirmed = !exchangeManaged || result.protection?.confirmed === true;
      if (result.ok) {
        // When the exchange holds the SL/TP, don't also manage them locally (avoids double-close).
        const entryTime = bot.buffer[index]?.time ?? bot.buffer.at(-1)?.time ?? 0;
        const submittedQty = order.qty ?? qty;
        bot.managed = exchangeManaged && protectionConfirmed ? { side: dir, entry: bot.price, qty: submittedQty, entryTime } : { side: dir, entry: bot.price, qty: submittedQty, entryTime, stop, target, trail: intents.trail };
        if (!protectionConfirmed) {
          pauseRunningBot(bot, "Exchange accepted the entry without confirming requested protection; trading is paused for operator review.");
          this.log(bot.config.id, "error", bot.pauseReason ?? "Exchange protection was not confirmed.");
        }
        persistRuntimeState(bot);
      } else {
        this.log(bot.config.id, "error", `Open failed: ${result.message}`);
      }
      this.applyResult(bot, result, "signal:entry", order);
      if (result.ok && protectionConfirmed) {
        await notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "open", bot: bot.config.name, symbol: bot.config.symbol, text: `Opened ${dir.toUpperCase()} ${round(qty)} @ ${round(price)}${stop ? ` · SL ${round(stop)}` : ""}${target ? ` · TP ${round(target)}` : ""}` });
      } else if (result.ok) {
        await notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "error", bot: bot.config.name, symbol: bot.config.symbol, text: "Entry protection was not confirmed; trading paused." });
      }
    } finally {
      bot.orderInFlight = false;
    }
  }

  private async closePosition(bot: RunningBot, reason: "signal" | "stop" | "target") {
    if (!bot.managed) return;
    if (bot.orderInFlight) {
      this.log(bot.config.id, "warn", `Close skipped (${reason}) — another exchange order is still in flight`);
      return;
    }
    bot.orderInFlight = true;
    try {
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
      if (bot.config.market === "spot") {
        const qty = resolveSpotCloseQuantity(getSpotInventory(bot.config.id, bot.config.symbol));
        if (qty <= 0) {
          const reason = "Spot close refused: this bot has no confirmed attributed inventory.";
          pauseRunningBot(bot, reason);
          persistRuntimeState(bot);
          this.log(bot.config.id, "error", reason);
          return;
        }
        order.qty = qty;
        order.closePct = undefined;
      }
      const result = await this.executeOrder(bot, order, bot.buffer.at(-1)?.time);
      const accounting = this.applyResult(bot, result, `signal:${reason}`, order);
      if (accounting.pauseReason) {
        await notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "error", bot: bot.config.name, symbol: bot.config.symbol, text: "Close accepted; awaiting authenticated execution accounting. Trading paused." });
      } else if (result.ok && accounting.changed) {
        const pnl = result.fills.reduce((sum, f) => sum + f.realizedPnl, 0);
        await notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "close", bot: bot.config.name, symbol: bot.config.symbol, text: `${accounting.cleared ? "Closed" : "Reduced"} (${reason}) · PnL ${round(pnl)}` });
      } else {
        this.log(bot.config.id, "error", `Close failed: ${result.message}`);
      }
    } finally {
      bot.orderInFlight = false;
    }
  }

  private applyResult(bot: RunningBot, result: ExecResult, _reason: string, order: ExecOrder) {
    const accounting = applyEngineResult(bot, result, order, {
      log: (level, message) => this.log(bot.config.id, level, message),
      fill: (fill, account, position) => this.broadcastOwned({ type: "fill", botId: bot.config.id, fill, account, position }),
      state: (account, position) => this.broadcastOwned({ type: "bot", botId: bot.config.id, account, position })
    });
    const accountingFailure = accounting.failures.length > 0 && bot.config.exchange !== "paper" ? `${accounting.failures.length} synchronous live execution(s) could not cross durable accounting; managed state was preserved.` : undefined;
    const outcome = accountingFailure ? { changed: false, cleared: false, pauseReason: accountingFailure } : applySynchronousReduceOnlyExecution(bot, order, result, accounting.committedFills, accounting.duplicateFills.length);
    if (outcome.pauseReason) pauseRunningBot(bot, outcome.pauseReason);
    if (outcome.changed || outcome.pauseReason) persistRuntimeState(bot);
    if (outcome.pauseReason) this.log(bot.config.id, "warn", outcome.pauseReason);
    return outcome;
  }

  private async executeOrder(bot: RunningBot, order: ExecOrder, barTime?: number): Promise<ExecResult> {
    if (order.action === "close" || order.action === "flatten") order.reduceOnly = true;
    if (this.stopCoordinator.isStopping(bot.config.id)) throw new Error("Bot is stopping; new exchange orders are disabled.");
    return this.orderExecutionLock.run(engineOrderLockKey(bot), async () => {
      if (this.stopCoordinator.isStopping(bot.config.id)) throw new Error("Bot is stopping; new exchange orders are disabled.");
      if (bot.config.exchange !== "paper") assertPrivateExchangeAccess("live order execution", "mutation", this.runtimePolicy);
      if (bot.paused && !pausedOrderAllowed(order)) throw new Error("Trading is paused; only reduce-only exits, cancellation, and reads are allowed.");
      const release = bot.config.exchange !== "paper" ? this.emergencyForOwner(tradingOwnerForBot(bot.config)).beginLiveOrder() : undefined;
      try {
        const inventory = bot.config.market === "spot" ? getSpotInventory(bot.config.id, bot.config.symbol) : undefined;
        const spotQuantity = bot.config.market === "spot" ? (inventory && (inventory.botId !== bot.config.id || inventory.symbol !== bot.config.symbol) ? Number.NaN : (inventory?.remainingQty ?? 0)) : undefined;
        const futuresQuantity = bot.config.market === "futures" ? (getFuturesExposure(bot.config.id, bot.config.symbol)?.grossQty ?? 0) : undefined;
        const journalOrders = bot.config.exchange !== "paper" ? loadLiveRiskJournal(bot.config.id) : undefined;
        await preflightLiveOrder(bot.config, order, bot.adapter, bot.price, realizedToday(bot.config.id), { verifiedSpotQuantity: spotQuantity, accountedFuturesQuantity: futuresQuantity, journalOrders });
        if (bot.paused && !pausedOrderAllowed(order)) throw new Error("Trading was paused while live risk was being verified.");
        return await executeDurableEngineOrder(bot, order, barTime, (message) => this.log(bot.config.id, "error", message));
      } finally {
        release?.();
      }
    });
  }

  private log(botId: string, level: "info" | "warn" | "error", message: string) {
    const ts = Date.now();
    insertLog({ botId, level, message, ts });
    this.broadcastOwned({ type: "log", botId, log: { level, message, ts } });
  }

  private emitBot(id: string) {
    const bot = this.running.get(id);
    this.broadcastOwned({ type: "bot", botId: id, bot: bot?.config });
  }

  private ownedRuntime(ownerUserId: string, id: string): RunningBot | undefined { return this.tenants.owned(ownerUserId, id); }
  private broadcastOwned(event: TradeEvent): void { this.tenants.broadcast(event); }
  private emergencyForOwner(ownerUserId: string) { return this.tenants.emergency(ownerUserId); }
}
