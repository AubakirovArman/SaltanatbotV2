import type { Candle } from "@saltanatbotv2/contracts";

export type SecurityDataContext = Map<string, Candle[]> | Record<string, Candle[]>;

export function securitySeriesKey(symbol: string, timeframe: string): string {
  return `${normalizePart(symbol)}|${normalizePart(timeframe)}`;
}

export function getSecurityCandles(context: SecurityDataContext | undefined, symbol: string, timeframe: string): Candle[] | undefined {
  if (!context) return undefined;
  const keys = [
    securitySeriesKey(symbol, timeframe),
    `${symbol}:${timeframe}`,
    `${symbol}|${timeframe}`,
    `${symbol}/${timeframe}`
  ];
  for (const key of keys) {
    const value = context instanceof Map ? context.get(key) : context[key];
    if (value?.length) return value;
  }
  return undefined;
}

export function alignSecuritySeries(chartCandles: Candle[], sourceCandles: Candle[], sourceValues: number[]): number[] {
  const out = new Array<number>(chartCandles.length).fill(NaN);
  let srcIdx = -1;
  for (let i = 0; i < chartCandles.length; i += 1) {
    const t = chartCandles[i].time;
    while (srcIdx + 1 < sourceCandles.length && sourceCandles[srcIdx + 1].time <= t) srcIdx += 1;
    if (srcIdx >= 0) out[i] = sourceValues[srcIdx] ?? NaN;
  }
  return out;
}

function normalizePart(value: string): string {
  return value.trim().toUpperCase() || "CURRENT";
}
