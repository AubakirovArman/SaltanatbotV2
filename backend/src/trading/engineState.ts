import { timeframeMs } from "../market/timeframes.js";
import { listFills, setSetting } from "./store.js";
import type { BotStateSnapshot, RunningBot } from "./engineRuntime.js";

export function realizedToday(botId: string, now = Date.now()): number {
  const startOfDay = Math.floor(now / 86_400_000) * 86_400_000;
  return listFills(botId, 500)
    .filter((fill) => fill.ts >= startOfDay)
    .reduce((sum, fill) => sum + fill.realizedPnl, 0);
}

export function persistPaper(bot: RunningBot) {
  if (bot.paper) setSetting(`paper:${bot.config.id}`, bot.paper.getState());
}

/** Latest account equity, cached so a failed read carries the last known value. */
export async function equityOf(bot: RunningBot): Promise<number> {
  const account = await bot.adapter.account().catch(() => undefined);
  if (account) bot.lastEquity = account.equity;
  return bot.lastEquity ?? 0;
}

export function positionContext(bot: RunningBot, equity: number, now = Date.now()): Record<string, number> {
  const closes = listFills(bot.config.id, 500).filter((fill) => fill.kind === "close");
  let consecutiveLosses = 0;
  for (const fill of closes) {
    if (fill.realizedPnl < 0) consecutiveLosses += 1;
    else break;
  }
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const todays = closes.filter((fill) => fill.ts >= dayStart);
  const context: Record<string, number> = {
    last_trade_pnl: closes[0]?.realizedPnl ?? 0,
    consecutive_losses: consecutiveLosses,
    trades_today: todays.length,
    realized_today: todays.reduce((sum, fill) => sum + fill.realizedPnl, 0),
    equity
  };
  const managed = bot.managed;
  if (!managed) return context;
  const move = managed.side === "long" ? bot.price - managed.entry : managed.entry - bot.price;
  const interval = timeframeMs[bot.config.timeframe] ?? 60_000;
  const lastBarTime = bot.buffer.at(-1)?.time ?? managed.entryTime;
  context.position_dir = managed.side === "long" ? 1 : -1;
  context.entry_price = managed.entry;
  context.unrealized_pnl = managed.qty * move;
  context.unrealized_pnl_pct = managed.entry ? (move / managed.entry) * 100 : 0;
  context.bars_in_position = Math.max(0, Math.round((lastBarTime - managed.entryTime) / interval));
  return context;
}

export function persistRuntimeState(bot: RunningBot, now = Date.now()) {
  const snapshot: BotStateSnapshot = {
    vars: Object.fromEntries(bot.vars),
    managed: bot.managed,
    paused: bot.paused === true,
    pauseReason: bot.pauseReason,
    lastBarTime: bot.buffer.at(-1)?.time ?? 0,
    savedAt: now
  };
  setSetting(`state:${bot.config.id}`, snapshot);
}

export function pauseRunningBot(bot: RunningBot, reason: string) {
  bot.paused = true;
  bot.pauseReason = reason;
}
