import type { Candle } from "../types";
import { confirmedCandles } from "./confirmedCandles";

export type RenkoDirection = "up" | "down";

export interface RenkoCandle extends Candle {
  direction: RenkoDirection;
  brickSize: number;
  sourceCount: number;
}

export interface RenkoOptions {
  decimals: number;
  brickPercent?: number;
}

export const DEFAULT_RENKO_BRICK_PERCENT = 0.05;

/**
 * Build confirmed close-only traditional Renko bricks. The box size is fixed
 * from the first loaded confirmed close, so new live bars cannot resize history.
 */
export function buildRenko(candles: readonly Candle[], options: RenkoOptions): RenkoCandle[] {
  const source = confirmedCandles(candles);
  if (source.length < 2) return [];
  const decimals = Math.max(0, Math.min(12, Math.round(options.decimals)));
  const tick = 10 ** -decimals;
  const percent = Math.max(0.01, Math.min(10, options.brickPercent ?? DEFAULT_RENKO_BRICK_PERCENT));
  const brickSize = round(Math.max(tick, Math.round(source[0].close * percent / 100 / tick) * tick), decimals);
  const anchor = round(Math.round(source[0].close / tick) * tick, decimals);
  const bricks: RenkoCandle[] = [];
  let pendingVolume = source[0].volume;
  let pendingCount = 1;
  let pendingHigh = source[0].close;
  let pendingLow = source[0].close;

  for (let index = 1; index < source.length; index += 1) {
    const candle = source[index];
    pendingVolume += candle.volume;
    pendingCount += 1;
    pendingHigh = Math.max(pendingHigh, candle.close);
    pendingLow = Math.min(pendingLow, candle.close);
    const specs = nextBricks(bricks.at(-1), anchor, candle.close, brickSize, decimals);
    if (specs.length === 0) continue;
    const volume = pendingVolume / specs.length;
    specs.forEach((spec, brickIndex) => {
      const adverse = brickIndex === 0;
      bricks.push({
        time: candle.time,
        open: spec.open,
        high: spec.direction === "down" && adverse ? Math.max(spec.open, pendingHigh) : Math.max(spec.open, spec.close),
        low: spec.direction === "up" && adverse ? Math.min(spec.open, pendingLow) : Math.min(spec.open, spec.close),
        close: spec.close,
        volume,
        final: true,
        source: candle.source,
        direction: spec.direction,
        brickSize,
        sourceCount: brickIndex === 0 ? pendingCount : 0
      });
    });
    pendingVolume = 0;
    pendingCount = 0;
    pendingHigh = candle.close;
    pendingLow = candle.close;
  }
  return bricks;
}

function nextBricks(last: RenkoCandle | undefined, anchor: number, price: number, size: number, decimals: number) {
  const specs: Array<{ open: number; close: number; direction: RenkoDirection }> = [];
  let cursor = last?.close ?? anchor;
  let direction: RenkoDirection | undefined;
  if (!last) direction = price >= cursor + size ? "up" : price <= cursor - size ? "down" : undefined;
  else if (last.direction === "up") {
    if (price >= cursor + size) direction = "up";
    else if (price <= last.open - size) {
      direction = "down";
      cursor = last.open;
    }
  } else if (price <= cursor - size) direction = "down";
  else if (price >= last.open + size) {
    direction = "up";
    cursor = last.open;
  }
  if (!direction) return specs;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const close = round(cursor + (direction === "up" ? size : -size), decimals);
    if (direction === "up" ? price < close : price > close) break;
    specs.push({ open: cursor, close, direction });
    cursor = close;
  }
  return specs;
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
