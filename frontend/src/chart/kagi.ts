import type { Candle } from "../types";
import { confirmedCandles } from "./confirmedCandles";

export type KagiDirection = "up" | "down";

export interface KagiCandle extends Candle {
  direction: KagiDirection;
  reversalSize: number;
  sourceCount: number;
}

export interface KagiOptions {
  decimals: number;
  reversalPercent?: number;
}

export const DEFAULT_KAGI_REVERSAL_PERCENT = 0.1;

/**
 * Build confirmed close-only Kagi legs. A leg extends only at a new close
 * extreme; a new column starts after the fixed reversal distance is crossed.
 */
export function buildKagi(candles: readonly Candle[], options: KagiOptions): KagiCandle[] {
  const source = confirmedCandles(candles);
  if (source.length < 2) return [];
  const decimals = Math.max(0, Math.min(12, Math.round(options.decimals)));
  const tick = 10 ** -decimals;
  const percent = Math.max(0.01, Math.min(10, options.reversalPercent ?? DEFAULT_KAGI_REVERSAL_PERCENT));
  const reversalSize = round(Math.max(tick, Math.round(source[0].close * percent / 100 / tick) * tick), decimals);
  const anchor = round(Math.round(source[0].close / tick) * tick, decimals);
  const legs: KagiCandle[] = [];
  let current: KagiCandle | undefined;
  let pendingVolume = source[0].volume;
  let pendingCount = 1;

  for (let index = 1; index < source.length; index += 1) {
    const candle = source[index];
    if (!current) {
      pendingVolume += candle.volume;
      pendingCount += 1;
      if (Math.abs(candle.close - anchor) < reversalSize) continue;
      current = leg(anchor, candle.close, candle, candle.close > anchor ? "up" : "down", reversalSize, pendingVolume, pendingCount);
      pendingVolume = 0;
      pendingCount = 0;
      continue;
    }

    if (extendsLeg(current, candle.close)) {
      current.close = candle.close;
      current.high = Math.max(current.open, candle.close);
      current.low = Math.min(current.open, candle.close);
      current.time = candle.time;
      current.source = candle.source;
      current.volume += candle.volume;
      current.sourceCount += 1;
      continue;
    }

    const reverses = current.direction === "up"
      ? candle.close <= current.close - reversalSize
      : candle.close >= current.close + reversalSize;
    if (reverses) {
      legs.push(current);
      current = leg(current.close, candle.close, candle, current.direction === "up" ? "down" : "up", reversalSize, candle.volume, 1);
      continue;
    }

    current.volume += candle.volume;
    current.sourceCount += 1;
    current.time = candle.time;
    current.source = candle.source;
  }

  if (current) legs.push(current);
  return legs;
}

function extendsLeg(current: KagiCandle, price: number) {
  return current.direction === "up" ? price > current.close : price < current.close;
}

function leg(
  open: number,
  close: number,
  candle: Candle,
  direction: KagiDirection,
  reversalSize: number,
  volume: number,
  sourceCount: number
): KagiCandle {
  return {
    time: candle.time,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
    final: true,
    source: candle.source,
    direction,
    reversalSize,
    sourceCount
  };
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
