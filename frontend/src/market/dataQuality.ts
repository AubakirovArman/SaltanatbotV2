import type { Candle, Timeframe } from "../types";

const timeframeMs: Record<Timeframe, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
  "1d": 86_400_000, "1w": 604_800_000, "1M": 2_592_000_000
};

export interface DataGapSummary {
  gapCount: number;
  missingBars: number;
  largestGapMs: number;
}

export function analyzeCandleGaps(candles: readonly Candle[], timeframe: Timeframe): DataGapSummary {
  const expected = timeframeMs[timeframe];
  let gapCount = 0;
  let missingBars = 0;
  let largestGapMs = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const difference = candles[index].time - candles[index - 1].time;
    if (difference <= expected * 1.5) continue;
    gapCount += 1;
    missingBars += Math.max(1, Math.round(difference / expected) - 1);
    largestGapMs = Math.max(largestGapMs, difference);
  }
  return { gapCount, missingBars, largestGapMs };
}
