import type { Candle } from "../types";

/**
 * Heikin Ashi smoothing. Computed over the supplied window; the first bar seeds
 * its open from the raw open/close midpoint.
 */
export function toHeikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  candles.forEach((candle, index) => {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open = index === 0 ? (candle.open + candle.close) / 2 : (prevOpen + prevClose) / 2;
    const high = Math.max(candle.high, open, close);
    const low = Math.min(candle.low, open, close);
    out.push({ ...candle, open, high, low, close });
    prevOpen = open;
    prevClose = close;
  });
  return out;
}
