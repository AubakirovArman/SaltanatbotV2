import type { Candle } from "../types";
import { confirmedCandleCount } from "./confirmedCandles";

export { confirmedCandleCount } from "./confirmedCandles";

export type LineBreakDirection = "up" | "down";

export interface LineBreakCandle extends Candle {
  direction: LineBreakDirection;
  sourceCount: number;
}

/**
 * Build classic close-only Line Break candles. Continuations extend the last
 * line; reversals must exceed the full range of the latest `reversalLines`.
 * The provisional source tail is intentionally excluded to avoid repainting.
 */
export function buildLineBreak(candles: readonly Candle[], reversalLines = 3): LineBreakCandle[] {
  const count = confirmedCandleCount(candles);
  if (count < 2) return [];
  const source = candles.slice(0, count);
  const depth = Math.max(1, Math.min(10, Math.round(reversalLines)));
  const lines: LineBreakCandle[] = [];
  let anchor = source[0].close;
  let accumulatedVolume = source[0].volume;
  let sourceCount = 1;

  for (let index = 1; index < source.length; index += 1) {
    const candle = source[index];
    accumulatedVolume += candle.volume;
    sourceCount += 1;
    const last = lines.at(-1);
    let direction: LineBreakDirection | undefined;

    if (!last) {
      if (candle.close > anchor) direction = "up";
      if (candle.close < anchor) direction = "down";
    } else if (last.direction === "up") {
      if (candle.close > last.close) direction = "up";
      else if (candle.close < reversalLow(lines, depth)) direction = "down";
    } else {
      if (candle.close < last.close) direction = "down";
      else if (candle.close > reversalHigh(lines, depth)) direction = "up";
    }

    if (!direction) continue;
    const open = last?.close ?? anchor;
    lines.push({
      time: candle.time,
      open,
      high: Math.max(open, candle.close),
      low: Math.min(open, candle.close),
      close: candle.close,
      volume: accumulatedVolume,
      final: true,
      source: candle.source,
      direction,
      sourceCount
    });
    anchor = candle.close;
    accumulatedVolume = 0;
    sourceCount = 0;
  }

  return lines;
}

function reversalLow(lines: readonly LineBreakCandle[], depth: number) {
  return Math.min(...lines.slice(-depth).map((line) => line.low));
}

function reversalHigh(lines: readonly LineBreakCandle[], depth: number) {
  return Math.max(...lines.slice(-depth).map((line) => line.high));
}
