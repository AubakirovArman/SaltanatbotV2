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
import { getSetting, listBots, setSetting } from "./store.js";
import { escapeHtml, formatStatus, HELP_TEXT, parseCommand, type StatusRow } from "./telegramCommands.js";
import type { BotConfig } from "./types.js";

// Re-export the pure helpers so callers/tests have a single import surface.
export { formatStatus, parseCommand };
export type { ParsedCommand, StatusRow } from "./telegramCommands.js";

// ---------- the poller ----------

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string }; text?: string };
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

  constructor(private readonly engine: TradingEngine) {}

  /**
   * Start the poll loop if Telegram control is configured. Safe to call multiple
   * times — a second call while already running is a no-op. When control is not
   * configured this returns immediately (the default no-op path).
   */
  start(): void {
    if (this.running) return;
    if (!isTelegramControlEnabled()) return;
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
    if (isTelegramControlEnabled()) this.start();
    else this.stop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      // Re-read config each iteration so a UI toggle takes effect live.
      const telegram = getNotifyConfig().telegram;
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
        await this.send(telegram, chatIdStr, "⛔ unauthorized").catch(() => undefined);
      }
      return;
    }

    const { cmd, arg } = parseCommand(text);
    const reply = await this.runCommand(cmd, arg);
    if (reply) await this.send(telegram, telegram.chatId, reply).catch(() => undefined);
  }

  /** Map a parsed command to its reply text. Interacts with the engine/store. */
  private async runCommand(cmd: string, arg: string): Promise<string> {
    switch (cmd) {
      case "help":
      case "start_help":
        return HELP_TEXT;
      case "status":
        return await this.statusReply();
      case "stop":
        return this.stopReply(arg);
      case "start":
        return await this.startReply(arg);
      case "kill":
        return this.killReply();
      case "":
        return ""; // plain chat message — stay silent
      default:
        return `Unknown command: /${escapeHtml(cmd)}\n${HELP_TEXT}`;
    }
  }

  private async statusReply(): Promise<string> {
    const bots = listBots();
    let portfolio: Awaited<ReturnType<TradingEngine["portfolio"]>> | undefined;
    try {
      portfolio = await this.engine.portfolio();
    } catch {
      portfolio = undefined;
    }
    const rows: StatusRow[] = [];
    for (const bot of bots) {
      const running = this.engine.isRunning(bot.id);
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
    const live = await this.engine.liveState(bot.id);
    const pos = live?.position;
    if (!pos) return null;
    return { side: pos.side, qty: pos.qty };
  }

  private stopReply(arg: string): string {
    const target = arg.trim();
    if (!target) return "Usage: /stop &lt;name|all&gt;";
    if (target.toLowerCase() === "all") {
      this.engine.stopAll();
      return "⏹️ Stopped all bots.";
    }
    const bot = findBotByName(target);
    if (!bot) return `No bot named "${escapeHtml(target)}".`;
    if (!this.engine.isRunning(bot.id)) return `<b>${escapeHtml(bot.name)}</b> is not running.`;
    this.engine.stop(bot.id);
    return `⏹️ Stopped <b>${escapeHtml(bot.name)}</b>.`;
  }

  private async startReply(arg: string): Promise<string> {
    const target = arg.trim();
    if (!target) return "Usage: /start &lt;name&gt;";
    const bot = findBotByName(target);
    if (!bot) return `No bot named "${escapeHtml(target)}".`;
    if (this.engine.isRunning(bot.id)) return `<b>${escapeHtml(bot.name)}</b> is already running.`;

    // LIVE bots honour the same arm gate as the HTTP route. Telegram is the
    // confirm step for an already-armed account — it must NOT bypass the arm.
    if (bot.exchange !== "paper" && getSetting<boolean>("liveTradingEnabled") !== true) {
      return `🔒 Live trading is not armed. Arm it in the web UI (Trade settings) before starting <b>${escapeHtml(bot.name)}</b>.`;
    }
    try {
      await this.engine.start(bot);
      return `▶️ Started <b>${escapeHtml(bot.name)}</b> on ${escapeHtml(bot.exchange)} · ${escapeHtml(bot.symbol)}.`;
    } catch (error) {
      return `⚠️ Failed to start <b>${escapeHtml(bot.name)}</b>: ${escapeHtml(error instanceof Error ? error.message : String(error))}`;
    }
  }

  private killReply(): string {
    this.engine.stopAll();
    setSetting("liveTradingEnabled", false);
    return "🛑 Kill switch engaged — all bots stopped and live trading disarmed.";
  }

  private async send(telegram: TelegramConfig, chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}`);
  }
}

// ---------- helpers ----------

/** Case-insensitive bot lookup by name. */
export function findBotByName(name: string): BotConfig | undefined {
  const wanted = name.trim().toLowerCase();
  return listBots().find((bot) => bot.name.toLowerCase() === wanted);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
