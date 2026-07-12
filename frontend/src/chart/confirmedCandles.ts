import type { Candle } from "../types";

/** The live tail is provisional unless the provider explicitly finalized it. */
export function confirmedCandleCount(candles: readonly Candle[]): number {
  if (candles.length === 0) return 0;
  return candles.at(-1)?.final === true ? candles.length : candles.length - 1;
}

export function confirmedCandles(candles: readonly Candle[]): Candle[] {
  return candles.slice(0, confirmedCandleCount(candles));
}
