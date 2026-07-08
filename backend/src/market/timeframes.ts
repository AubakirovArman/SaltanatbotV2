import type { Timeframe } from "../types.js";

export const timeframes: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export const timeframeMs: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000
};

export const binanceIntervals: Partial<Record<Timeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d"
};

/** Bybit v5 kline intervals: minutes as numbers, day/week/month as letters. */
export const bybitIntervals: Partial<Record<Timeframe, string>> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D"
};

export function alignTime(ts: number, timeframe: Timeframe) {
  return Math.floor(ts / timeframeMs[timeframe]) * timeframeMs[timeframe];
}
