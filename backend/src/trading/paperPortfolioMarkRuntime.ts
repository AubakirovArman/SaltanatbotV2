import { timeframeMs } from "../market/timeframes.js";
import type { Candle } from "../types.js";
import type { RunningBot } from "./engineRuntime.js";
import { pauseRunningBot, persistRuntimeState } from "./engineState.js";
import { PAPER_MARK_FRESHNESS_CEILING_MS } from "./paperPortfolioProjectionStore.js";
import { PAPER_MONEY_MICROS_MAX } from "./paperPortfolioMigration.js";
import { upsertPaperValuationMark } from "./store.js";
import { tradingOwnerForBot } from "./ownership.js";
import type { PaperValuationMark } from "./paperPortfolioStoreSupport.js";

/** Persist a closed-candle valuation mark or pause paper execution fail-closed. */
export function persistClosedPaperMark(
  bot: RunningBot,
  candle: Candle,
  report: (message: string) => void,
  now = Date.now(),
  write: (mark: PaperValuationMark) => unknown = upsertPaperValuationMark
): boolean {
  const config = bot.config;
  try {
    const mark = paperValuationMarkFromClosedCandle(config, candle, now);
    if (!mark) return true;
    write(mark);
    return true;
  } catch (error) {
    const message = `Durable paper valuation mark failed: ${error instanceof Error ? error.message : "unknown error"}`;
    pauseRunningBot(bot, message);
    try { persistRuntimeState(bot, now); } catch { /* The original store failure remains authoritative. */ }
    report(message);
    return false;
  }
}

export function paperValuationMarkFromClosedCandle(
  config: RunningBot["config"],
  candle: Candle,
  now: number
): PaperValuationMark | undefined {
  if (
    config.exchange !== "paper"
    || !config.paperPortfolioId
    || !config.paperLedgerEpoch
    || !config.paperAllocationMicros
    || !config.revision
  ) return undefined;
  const interval = timeframeMs[config.timeframe] ?? 60_000;
  const observedAt = Math.min(now, candle.time + interval);
  const freshness = Math.min(PAPER_MARK_FRESHNESS_CEILING_MS, Math.max(2 * interval, 120_000));
  return {
    ownerUserId: tradingOwnerForBot(config),
    portfolioId: config.paperPortfolioId,
    ledgerEpoch: config.paperLedgerEpoch,
    botId: config.id,
    botRevision: config.revision,
    symbol: config.symbol,
    priceMicros: fixedPriceMicros(candle.close),
    asOf: observedAt,
    source: `paper:${candle.source ?? "market"}:closed-candle`.slice(0, 120),
    expiresAt: observedAt + freshness,
    evidence: {
      kind: "closed-candle",
      candleTime: candle.time,
      timeframe: config.timeframe,
      priceField: "close",
      final: candle.final === true
    },
    persistedAt: now
  };
}

function fixedPriceMicros(value: number): number {
  const micros = Math.round(value * 1_000_000);
  if (
    !Number.isFinite(value)
    || value <= 0
    || !Number.isSafeInteger(micros)
    || micros <= 0
    || micros > PAPER_MONEY_MICROS_MAX
  ) throw new Error("Closed-candle price is outside fixed USDT-micros bounds");
  return micros;
}
