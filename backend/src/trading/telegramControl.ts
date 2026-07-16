/**
 * Two-way Telegram control channel.
 *
 * When the Telegram notify channel is configured (token + chatId) and enabled,
 * this long-polls `getUpdates` and lets the configured operator command their
 * bots from chat (`/status`, `/start`, `/stop`, `/kill`, `/help`).
 *
 * Security: commands are ONLY accepted from the configured `chatId`. Any other
 * chat is denied — this is the boundary that stops a random Telegram user from
 * controlling live trading. Starting a LIVE bot from chat honours the same
 * `liveTradingEnabled` arm flag as the HTTP route (chat is the confirm step for
 * an already-armed account; it never bypasses the arm).
 *
 * Fail-safe: every network/parse error backs off and retries. The loop never
 * throws out of itself, so a Telegram outage can't crash the process. It is a
 * no-op when no token/chatId is configured (the default), so the app starts
 * clean without any Telegram setup.
 */

import type { TradingEngine } from "./engine.js";
import { getNotifyConfig, isTelegramControlEnabled, type TelegramConfig } from "./notifications.js";
import { getTradingOwnerAuthorityForOwner, LEGACY_TRADING_OWNER_ID, listBotsForOwner, listLogsForOwner, setTradingOwnerArmedForOwner } from "./store.js";
import { type BotDetail, escapeHtml, formatBotDetail, formatPortfolio, formatStatus, HELP_TEXT, parseCommand, type StatusRow } from "./telegramCommands.js";
import type { BotConfig } from "./types.js";
import { getRuntimePolicy, isPaperOnlyRuntime, type RuntimePolicy } from "../runtimeProfile.js";

/** An inline-keyboard reply: rows of buttons carrying callback `data`. */
type Keyboard = { text: string; data: string }[][];
interface Reply {
  text: string;
  keyboard?: Keyboard;
}

// Re-export the pure helpers so callers/tests have a single import surface.
export { formatStatus, parseCommand };
export type { ParsedCommand, StatusRow } from "./telegramCommands.js";

// ---------- the poller ----------

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number | string } } };
}

const POLL_TIMEOUT_S = 25;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class TelegramControl {
  private running = false;
  private offset = 0;
  private backoff = MIN_BACKOFF_MS;
  /** Chat ids we've already told "unauthorized" — reply once, then stay quiet. */
  private readonly warnedChats = new Set<string>();
  private loopPromise?: Promise<void>;

  constructor(
    private readonly engine: TradingEngine,
    private readonly ownerUserId = LEGACY_TRADING_OWNER_ID,
    private readonly inboundEnabled = true,
    private readonly runtimePolicy: RuntimePolicy = getRuntimePolicy()
  ) {}

  /**
   * Start the poll loop if Telegram control is configured. Safe to call multiple
   * times — a second call while already running is a no-op. When control is not
   * configured this returns immediately (the default no-op path).
   */
  start(): void {
    if (!this.inboundEnabled) return;
    if (this.running) return;
    if (!isTelegramControlEnabled(getNotifyConfig(this.ownerUserId).telegram)) return;
    this.running = true;
    this.backoff = MIN_BACKOFF_MS;
    this.loopPromise = this.loop().catch((error) => {
      // Defensive: loop() is written to never throw, but never let a stray
      // rejection escape and crash the process.
      console.log(`[telegram-control] loop exited unexpectedly: ${String(error)}`);
    });
  }

  /** Graceful shutdown — stops polling. Call from SIGINT/SIGTERM. */
  stop(): void {
    this.running = false;
  }

  /**
   * Re-evaluate config (call after POST /notify). Enabling Telegram in the UI
   * activates control without a restart; disabling it stops the loop.
   */
  refresh(): void {
    if (!this.inboundEnabled) {
      this.stop();
      return;
    }
    if (isTelegramControlEnabled(getNotifyConfig(this.ownerUserId).telegram)) this.start();
    else this.stop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      // Re-read config each iteration so a UI toggle takes effect live.
      const telegram = getNotifyConfig(this.ownerUserId).telegram;
      if (!isTelegramControlEnabled(telegram)) {
        this.running = false;
        break;
      }
      try {
        const updates = await this.fetchUpdates(telegram);
        this.backoff = MIN_BACKOFF_MS; // success — reset backoff
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(telegram, update).catch((error) => {
            // A single bad command must not stop the loop.
            console.log(`[telegram-control] handler error: ${String(error)}`);
          });
        }
      } catch (error) {
        // Any fetch/parse failure: back off (capped) and retry. Never throw out.
        console.log(`[telegram-control] poll error: ${String(error)}`);
        await sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async fetchUpdates(telegram: TelegramConfig): Promise<TelegramUpdate[]> {
    const url = `https://api.telegram.org/bot${telegram.token}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT_S}`;
    // Give fetch a little longer than the server-side long-poll timeout so a
    // normal empty poll returns from Telegram, not from an abort.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 10) * 1000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Telegram getUpdates HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      if (!body.ok || !Array.isArray(body.result)) return [];
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleUpdate(telegram: TelegramConfig, update: TelegramUpdate): Promise<void> {
    // Inline-keyboard button press.
    if (update.callback_query) {
      const cb = update.callback_query;
      if (String(cb.message?.chat?.id) !== String(telegram.chatId)) {
        await this.answerCallback(telegram, cb.id, "unauthorized").catch(() => undefined);
        return;
      }
      const result = await this.runCallback(cb.data ?? "");
      await this.answerCallback(telegram, cb.id, result.toast).catch(() => undefined);
      if (result.text) await this.send(telegram, telegram.chatId, { text: result.text }).catch(() => undefined);
      return;
    }

    const message = update.message;
    const text = message?.text;
    if (!text) return;
    const chatId = message?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    const chatIdStr = String(chatId);

    // AUTHORIZATION: only the configured chatId may command anything. This is the
    // security boundary — reply "unauthorized" once, then ignore.
    if (chatIdStr !== String(telegram.chatId)) {
      if (!this.warnedChats.has(chatIdStr)) {
        this.warnedChats.add(chatIdStr);
        await this.send(telegram, chatIdStr, { text: "⛔ unauthorized" }).catch(() => undefined);
      }
      return;
    }

    const { cmd, arg } = parseCommand(text);
    const reply = await this.runCommand(cmd, arg);
    if (reply.text) await this.send(telegram, telegram.chatId, reply).catch(() => undefined);
  }

  /** Map a parsed command to its reply. Interacts with the engine/store. */
  private async runCommand(cmd: string, arg: string): Promise<Reply> {
    switch (cmd) {
      case "help":
      case "start_help":
        return { text: HELP_TEXT };
      case "status":
        return { text: await this.statusReply() };
      case "bot":
        return { text: await this.botReply(arg), keyboard: this.botKeyboard(arg) };
      case "pnl":
        return { text: await this.pnlReply() };
      case "stop":
        return { text: await this.stopReply(arg) };
      case "start":
        return { text: await this.startReply(arg) };
      case "close":
        return { text: await this.closeReply(arg) };
      case "resume":
        return { text: await this.resumeReply(arg) };
      case "logs":
        return { text: this.logsReply(arg) };
      case "mute":
        return { text: this.muteReply(arg, true) };
      case "unmute":
        return { text: this.muteReply(arg, false) };
      case "kill":
        if (isPaperOnlyRuntime(this.runtimePolicy)) {
          return { text: "🔒 Private exchange emergency actions are disabled in Research / Paper mode. Use /stop all to stop paper bots." };
        }
        // Require an explicit button press before the destructive kill.
        return { text: "⚠️ Confirm: disarm live trading, stop ALL bots and cancel account orders? Positions stay open.", keyboard: [[{ text: "🛑 Confirm kill", data: "kill:yes" }]] };
      case "":
        return { text: "" }; // plain chat message — stay silent
      default:
        return { text: `Unknown command: /${escapeHtml(cmd)}\n${HELP_TEXT}` };
    }
  }

  /** Execute an inline-keyboard button press (data = "action:botId"). */
  private async runCallback(data: string): Promise<{ toast: string; text?: string }> {
    const [action, id] = data.split(":");
    switch (action) {
      case "kill":
        if (isPaperOnlyRuntime(this.runtimePolicy)) return { toast: "Paper only", text: "🔒 Private exchange emergency actions are disabled in Research / Paper mode." };
        setTradingOwnerArmedForOwner(this.ownerUserId, false);
        {
          const result = await this.engine.emergencyStopForOwner(this.ownerUserId);
          if (!result.ok) {
            return { toast: "Partial failure", text: `⚠️ Emergency stop is incomplete. Live trading remains disarmed.\n${result.errors.map(escapeHtml).join("\n")}` };
          }
          return { toast: "Confirmed", text: "🛑 Emergency stop confirmed — bots stopped, open orders cancelled, live trading disarmed." };
        }
      case "resume":
        if (this.isLiveActionBlocked(id)) return { toast: "Paper only" };
        return { toast: (await this.engine.confirmResumeForOwner(this.ownerUserId, id)) ? "Resumed" : "Not paused" };
      case "stop":
        try {
          if (!this.engine.runtimeConfigForOwner(this.ownerUserId, id)) return { toast: "Not found" };
          await this.engine.stopSafelyForOwner(this.ownerUserId, id);
          return { toast: "Stopped" };
        } catch {
          return { toast: "Stop failed" };
        }
      case "close": {
        if (this.isLiveActionBlocked(id)) return { toast: "Paper only" };
        const ok = this.engine.runtimeConfigForOwner(this.ownerUserId, id) ? await this.engine.closeNow(id).catch(() => false) : false;
        return { toast: ok ? "Closed" : "No position" };
      }
      default:
        return { toast: "?" };
    }
  }

  private botKeyboard(arg: string): Keyboard | undefined {
    const bot = findBotByName(arg, this.ownerUserId);
    if (!bot || !this.engine.isRunningForOwner(this.ownerUserId, bot.id)) return undefined;
    const row: { text: string; data: string }[] = [];
    const privateActionBlocked = bot.exchange !== "paper" && isPaperOnlyRuntime(this.runtimePolicy);
    if (!privateActionBlocked && this.engine.isPausedForOwner(this.ownerUserId, bot.id)) row.push({ text: "▶️ Resume", data: `resume:${bot.id}` });
    if (!privateActionBlocked) row.push({ text: "✋ Close", data: `close:${bot.id}` });
    row.push({ text: "⏹️ Stop", data: `stop:${bot.id}` });
    return [row];
  }

  private async botReply(arg: string): Promise<string> {
    const target = arg.trim();
    if (!target) return "Usage: /bot &lt;name&gt;";
    const bot = findBotByName(target, this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(target)}".`;
    const running = this.engine.isRunningForOwner(this.ownerUserId, bot.id);
    const detail: BotDetail = { name: bot.name, exchange: bot.exchange, symbol: bot.symbol, running, muted: this.engine.isMuted(bot.id) };
    if (running) {
      const live = await this.engine.liveStateForOwner(this.ownerUserId, bot.id).catch(() => null);
      detail.paused = live?.paused;
      detail.vars = live?.vars;
      const pos = live?.position;
      if (pos) {
        detail.position = { side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice };
        const price = live?.price ?? pos.entryPrice;
        const move = pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price;
        detail.unrealizedPct = pos.entryPrice ? (move / pos.entryPrice) * 100 : 0;
      }
      try {
        detail.realizedToday = (await this.engine.portfolio(this.ownerUserId)).realizedTodayByBot[bot.id];
      } catch {
        // ignore portfolio read failure
      }
    }
    return formatBotDetail(detail);
  }

  private async pnlReply(): Promise<string> {
    let portfolio: Awaited<ReturnType<TradingEngine["portfolio"]>>;
    try {
      portfolio = await this.engine.portfolio(this.ownerUserId);
    } catch {
      return "Couldn't read portfolio.";
    }
    const perBot = listBotsForOwner(this.ownerUserId)
      .filter((bot) => this.engine.isRunningForOwner(this.ownerUserId, bot.id))
      .map((bot) => ({ name: bot.name, realized: portfolio.realizedTodayByBot[bot.id] ?? 0 }));
    return formatPortfolio(portfolio.totalRealizedToday, perBot);
  }

  private async closeReply(arg: string): Promise<string> {
    const bot = findBotByName(arg.trim(), this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(arg.trim())}".`;
    if (bot.exchange !== "paper" && isPaperOnlyRuntime(this.runtimePolicy)) return "🔒 Live position actions are disabled in Research / Paper mode.";
    const ok = this.engine.runtimeConfigForOwner(this.ownerUserId, bot.id) ? await this.engine.closeNow(bot.id).catch(() => false) : false;
    return ok ? `✋ Closed <b>${escapeHtml(bot.name)}</b>'s position.` : `<b>${escapeHtml(bot.name)}</b> has no open position.`;
  }

  private async resumeReply(arg: string): Promise<string> {
    const bot = findBotByName(arg.trim(), this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(arg.trim())}".`;
    if (bot.exchange !== "paper" && isPaperOnlyRuntime(this.runtimePolicy)) return "🔒 Live bot resume is disabled in Research / Paper mode.";
    return (await this.engine.confirmResumeForOwner(this.ownerUserId, bot.id)) ? `▶️ Resumed <b>${escapeHtml(bot.name)}</b>.` : `<b>${escapeHtml(bot.name)}</b> isn't paused.`;
  }

  private logsReply(arg: string): string {
    const bot = findBotByName(arg.trim(), this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(arg.trim())}".`;
    const logs = listLogsForOwner(this.ownerUserId, bot.id, 8);
    if (!logs.length) return `No logs for <b>${escapeHtml(bot.name)}</b>.`;
    return [...logs]
      .reverse()
      .map((entry) => `${escapeHtml(entry.level)}: ${escapeHtml(entry.message)}`)
      .join("\n");
  }

  private muteReply(arg: string, muted: boolean): string {
    const bot = findBotByName(arg.trim(), this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(arg.trim())}".`;
    this.engine.setMuted(bot.id, muted);
    return muted ? `🔕 Muted <b>${escapeHtml(bot.name)}</b>'s alerts.` : `🔔 Unmuted <b>${escapeHtml(bot.name)}</b>.`;
  }

  private async statusReply(): Promise<string> {
    const bots = listBotsForOwner(this.ownerUserId);
    let portfolio: Awaited<ReturnType<TradingEngine["portfolio"]>> | undefined;
    try {
      portfolio = await this.engine.portfolio(this.ownerUserId);
    } catch {
      portfolio = undefined;
    }
    const rows: StatusRow[] = [];
    for (const bot of bots) {
      const running = this.engine.isRunningForOwner(this.ownerUserId, bot.id);
      const row: StatusRow = { name: bot.name, exchange: bot.exchange, symbol: bot.symbol, running };
      if (running) {
        row.position = await this.positionFor(bot).catch(() => null);
        row.realizedToday = portfolio?.realizedTodayByBot[bot.id];
      }
      rows.push(row);
    }
    return formatStatus(rows);
  }

  private async positionFor(bot: BotConfig): Promise<{ side: string; qty: number } | null> {
    const live = await this.engine.liveStateForOwner(this.ownerUserId, bot.id);
    const pos = live?.position;
    if (!pos) return null;
    return { side: pos.side, qty: pos.qty };
  }

  private async stopReply(arg: string): Promise<string> {
    const target = arg.trim();
    if (!target) return "Usage: /stop &lt;name|all&gt;";
    if (target.toLowerCase() === "all") {
      const failures: string[] = [];
      for (const bot of listBotsForOwner(this.ownerUserId).filter((candidate) => this.engine.isRunningForOwner(this.ownerUserId, candidate.id))) {
        try {
          await this.engine.stopSafelyForOwner(this.ownerUserId, bot.id);
        } catch {
          failures.push(bot.name);
        }
      }
      if (failures.length) return `⚠️ Failed to stop: ${failures.map(escapeHtml).join(", ")}.`;
      return "⏹️ Stopped all bots.";
    }
    const bot = findBotByName(target, this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(target)}".`;
    if (!this.engine.isRunningForOwner(this.ownerUserId, bot.id)) return `<b>${escapeHtml(bot.name)}</b> is not running.`;
    try {
      await this.engine.stopSafelyForOwner(this.ownerUserId, bot.id);
      return `⏹️ Stopped <b>${escapeHtml(bot.name)}</b>.`;
    } catch {
      return `⚠️ Failed to stop <b>${escapeHtml(bot.name)}</b>.`;
    }
  }

  private async startReply(arg: string): Promise<string> {
    const target = arg.trim();
    if (!target) return "Usage: /start &lt;name&gt;";
    const bot = findBotByName(target, this.ownerUserId);
    if (!bot) return `No bot named "${escapeHtml(target)}".`;
    if (this.engine.isRunningForOwner(this.ownerUserId, bot.id)) return `<b>${escapeHtml(bot.name)}</b> is already running.`;

    if (bot.exchange !== "paper" && isPaperOnlyRuntime(this.runtimePolicy)) {
      return `🔒 <b>${escapeHtml(bot.name)}</b> cannot start while the server is in Research / Paper mode.`;
    }

    // LIVE bots honour the same arm gate as the HTTP route. Telegram is the
    // confirm step for an already-armed account — it must NOT bypass the arm.
    if (bot.exchange !== "paper" && !getTradingOwnerAuthorityForOwner(this.ownerUserId).armed) {
      return `🔒 Live trading is not armed. Arm it in the web UI (Trade settings) before starting <b>${escapeHtml(bot.name)}</b>.`;
    }
    try {
      await this.engine.startForOwner(this.ownerUserId, bot);
      return `▶️ Started <b>${escapeHtml(bot.name)}</b> on ${escapeHtml(bot.exchange)} · ${escapeHtml(bot.symbol)}.`;
    } catch (error) {
      return `⚠️ Failed to start <b>${escapeHtml(bot.name)}</b>: ${escapeHtml(error instanceof Error ? error.message : String(error))}`;
    }
  }

  private async send(telegram: TelegramConfig, chatId: string, reply: Reply): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, text: reply.text, parse_mode: "HTML", disable_web_page_preview: true };
    if (reply.keyboard) {
      body.reply_markup = { inline_keyboard: reply.keyboard.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.data }))) };
    }
    const res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}`);
  }

  private async answerCallback(telegram: TelegramConfig, callbackId: string, text?: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${telegram.token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text })
    });
  }

  private isLiveActionBlocked(botId: string): boolean {
    return isPaperOnlyRuntime(this.runtimePolicy) && this.engine.runtimeConfigForOwner(this.ownerUserId, botId)?.exchange !== "paper";
  }
}

// ---------- helpers ----------

/** Case-insensitive bot lookup by name. */
export function findBotByName(name: string, ownerUserId = LEGACY_TRADING_OWNER_ID): BotConfig | undefined {
  const wanted = name.trim().toLowerCase();
  return listBotsForOwner(ownerUserId).find((bot) => bot.name.toLowerCase() === wanted);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
