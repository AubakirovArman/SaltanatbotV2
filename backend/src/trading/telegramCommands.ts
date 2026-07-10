/**
 * Pure command parsing + status formatting for the Telegram control channel.
 *
 * Kept free of engine/store/network imports so it is trivially unit-testable and
 * so importing it (e.g. from tests) never drags in `node:sqlite`. The stateful
 * poller lives in telegramControl.ts and re-exports these.
 */

export interface ParsedCommand {
  /** Lowercased command without the leading slash, e.g. "status". Empty if none. */
  cmd: string;
  /** Everything after the command, trimmed. Empty if none. */
  arg: string;
}

/**
 * Parse a Telegram message into a command + argument.
 *
 * - Recognises a leading `/` command; strips a `@botname` suffix so
 *   `/status@MyBot` works in groups.
 * - Command is lowercased for case-insensitive matching; the argument keeps its
 *   original case (bot names can be mixed-case) but is trimmed.
 * - Non-command text yields `{ cmd: "", arg: <text> }`.
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return { cmd: "", arg: trimmed };
  const spaceIdx = trimmed.search(/\s/);
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  // Strip the leading slash and any `@botname` mention.
  const cmd = head.slice(1).split("@")[0].toLowerCase();
  return { cmd, arg };
}

export interface StatusRow {
  name: string;
  exchange: string;
  symbol: string;
  running: boolean;
  /** Present for running bots that hold a position. */
  position?: { side: string; qty: number } | null;
  /** Today's realized PnL for running bots (quote currency). */
  realizedToday?: number;
}

/**
 * Render the `/status` reply (HTML). Pure: takes an already-collected row set so
 * it can be tested without touching the engine or network.
 */
export function formatStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return "No bots configured.";
  const lines = rows.map((row) => {
    const state = row.running ? "🟢 running" : "⚪ stopped";
    let line = `<b>${escapeHtml(row.name)}</b> · ${escapeHtml(row.exchange)} · ${escapeHtml(row.symbol)} · ${state}`;
    if (row.running) {
      if (row.position) {
        line += `\n   ↳ ${escapeHtml(row.position.side)} ${trimNum(row.position.qty)}`;
      } else {
        line += "\n   ↳ flat";
      }
      if (row.realizedToday !== undefined) {
        line += ` · PnL today ${trimNum(row.realizedToday)}`;
      }
    }
    return line;
  });
  return lines.join("\n");
}

export interface BotDetail {
  name: string;
  exchange: string;
  symbol: string;
  running: boolean;
  paused?: boolean;
  muted?: boolean;
  position?: { side: string; qty: number; entryPrice: number } | null;
  unrealizedPct?: number;
  realizedToday?: number;
  vars?: Record<string, number>;
}

/** Render the `/bot <name>` detail reply (HTML). Pure. */
export function formatBotDetail(d: BotDetail): string {
  const lines = [`<b>${escapeHtml(d.name)}</b> · ${escapeHtml(d.exchange)} · ${escapeHtml(d.symbol)}`];
  lines.push(d.running ? (d.paused ? "⏸️ paused (awaiting confirm)" : "🟢 running") : "⚪ stopped");
  if (d.position) {
    lines.push(`Position: ${escapeHtml(d.position.side)} ${trimNum(d.position.qty)} @ ${trimNum(d.position.entryPrice)}${d.unrealizedPct !== undefined ? ` · uPnL ${trimNum(d.unrealizedPct)}%` : ""}`);
  } else if (d.running) {
    lines.push("Position: flat");
  }
  if (d.realizedToday !== undefined) lines.push(`PnL today: ${trimNum(d.realizedToday)}`);
  if (d.muted) lines.push("🔕 alerts muted");
  const vars = d.vars ? Object.entries(d.vars) : [];
  if (vars.length) lines.push(`Vars: ${vars.map(([k, v]) => `${escapeHtml(k)}=${trimNum(v)}`).join(", ")}`);
  return lines.join("\n");
}

/** Render the `/pnl` reply (HTML). Pure. */
export function formatPortfolio(total: number, perBot: { name: string; realized: number }[]): string {
  if (perBot.length === 0) return "No running bots.";
  const lines = perBot.map((b) => `<b>${escapeHtml(b.name)}</b> · ${trimNum(b.realized)}`);
  lines.push(`— Total today: <b>${trimNum(total)}</b>`);
  return lines.join("\n");
}

/** Reply body for `/help`. */
export const HELP_TEXT = [
  "<b>SaltanatbotV2 control</b>",
  "/help — show this help",
  "/status — list bots and running positions",
  "/bot &lt;name&gt; — details for one bot",
  "/pnl — today's realized PnL across bots",
  "/start &lt;name&gt; — start a bot by name",
  "/stop &lt;name|all&gt; — stop a bot or all bots",
  "/close &lt;name&gt; — flatten a bot's position (keep it running)",
  "/resume &lt;name&gt; — resume a bot paused after a restart",
  "/logs &lt;name&gt; — recent log lines",
  "/mute &lt;name&gt; · /unmute &lt;name&gt; — silence/unsilence a bot's alerts",
  "/kill — stop everything and disarm live trading"
].join("\n");

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Round to at most 4 dp and drop trailing zeros for compact display. */
export function trimNum(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 1e4) / 1e4);
}
