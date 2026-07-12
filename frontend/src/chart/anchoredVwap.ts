import type { Candle } from "../types";
import type { DrawingObject } from "./drawings";

export interface AnchoredVwapPoint {
  time: number;
  vwap: number;
  deviation: number;
  cumulativeVolume: number;
}

export type AnchoredVwapSeries = Record<string, AnchoredVwapPoint[]>;

export function calculateDrawingAvwaps(candles: Candle[], drawings: DrawingObject[]): AnchoredVwapSeries {
  return Object.fromEntries(drawings
    .filter((drawing) => drawing.tool === "anchored-vwap" && !drawing.hidden && drawing.points[0])
    .map((drawing) => [drawing.id, calculateAnchoredVwap(candles, drawing.points[0].time)]));
}

/**
 * Cumulative bar-based AVWAP from the first candle at or after `anchorTime`.
 * Typical price is weighted by reported OHLCV volume; no intrabar distribution
 * or synthetic volume is inferred.
 */
export function calculateAnchoredVwap(candles: Candle[], anchorTime: number): AnchoredVwapPoint[] {
  if (!candles[0] || candles[0].time > anchorTime) return [];
  const start = candles.findIndex((candle) => candle.time >= anchorTime);
  if (start < 0) return [];
  const points: AnchoredVwapPoint[] = [];
  let volume = 0;
  let weighted = 0;
  let weightedSquare = 0;

  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    const typical = (candle.high + candle.low + candle.close) / 3;
    if (Number.isFinite(candle.volume) && candle.volume > 0 && Number.isFinite(typical)) {
      volume += candle.volume;
      weighted += typical * candle.volume;
      weightedSquare += typical * typical * candle.volume;
    }
    if (volume <= 0) continue;
    const vwap = weighted / volume;
    points.push({
      time: candle.time,
      vwap,
      deviation: Math.sqrt(Math.max(0, weightedSquare / volume - vwap * vwap)),
      cumulativeVolume: volume
    });
  }
  return points;
}
