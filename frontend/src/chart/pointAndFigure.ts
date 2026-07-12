import type { Candle } from "../types";
import { confirmedCandles } from "./confirmedCandles";

export type PointAndFigureDirection = "x" | "o";

export interface PointAndFigureColumn extends Candle {
  direction: PointAndFigureDirection;
  boxSize: number;
  boxes: number;
  reversalBoxes: number;
  sourceCount: number;
}

export interface PointAndFigureOptions {
  decimals: number;
  boxPercent?: number;
  reversalBoxes?: number;
}

export const DEFAULT_PNF_BOX_PERCENT = 0.1;
export const DEFAULT_PNF_REVERSAL_BOXES = 3;
const MAX_BOXES_PER_COLUMN = 10_000;

/** Build confirmed close-only Point & Figure columns with fixed seeded boxes. */
export function buildPointAndFigure(candles: readonly Candle[], options: PointAndFigureOptions): PointAndFigureColumn[] {
  const source = confirmedCandles(candles);
  if (source.length < 2) return [];
  const decimals = Math.max(0, Math.min(12, Math.round(options.decimals)));
  const tick = 10 ** -decimals;
  const percent = Math.max(0.01, Math.min(10, options.boxPercent ?? DEFAULT_PNF_BOX_PERCENT));
  const reversalBoxes = Math.max(1, Math.min(10, Math.round(options.reversalBoxes ?? DEFAULT_PNF_REVERSAL_BOXES)));
  const boxSize = round(Math.max(tick, Math.round(source[0].close * percent / 100 / tick) * tick), decimals);
  const anchor = round(Math.round(source[0].close / tick) * tick, decimals);
  const columns: PointAndFigureColumn[] = [];
  let current: PointAndFigureColumn | undefined;
  let pendingVolume = source[0].volume;
  let pendingCount = 1;

  for (let index = 1; index < source.length; index += 1) {
    const candle = source[index];
    if (!current) {
      pendingVolume += candle.volume;
      pendingCount += 1;
      const up = boxesBetween(anchor, candle.close, boxSize);
      const down = boxesBetween(candle.close, anchor, boxSize);
      if (up < 1 && down < 1) continue;
      const direction: PointAndFigureDirection = up >= 1 ? "x" : "o";
      const boxes = direction === "x" ? up : down;
      current = column(anchor, move(anchor, direction, boxes, boxSize, decimals), candle, direction, boxSize, boxes, reversalBoxes, pendingVolume, pendingCount);
      pendingVolume = 0;
      pendingCount = 0;
      continue;
    }

    const continuation = current.direction === "x"
      ? boxesBetween(current.close, candle.close, boxSize)
      : boxesBetween(candle.close, current.close, boxSize);
    if (continuation >= 1) {
      extend(current, move(current.close, current.direction, continuation, boxSize, decimals), continuation, candle);
      continue;
    }

    const reversal = current.direction === "x"
      ? boxesBetween(candle.close, current.close, boxSize)
      : boxesBetween(current.close, candle.close, boxSize);
    if (reversal >= reversalBoxes) {
      columns.push(current);
      const direction: PointAndFigureDirection = current.direction === "x" ? "o" : "x";
      current = column(current.close, move(current.close, direction, reversal, boxSize, decimals), candle, direction, boxSize, reversal, reversalBoxes, candle.volume, 1);
      continue;
    }

    current.volume += candle.volume;
    current.sourceCount += 1;
    current.time = candle.time;
    current.source = candle.source;
  }

  if (current) columns.push(current);
  return columns;
}

function boxesBetween(low: number, high: number, size: number) {
  return Math.min(MAX_BOXES_PER_COLUMN, Math.max(0, Math.floor((high - low) / size + 1e-9)));
}

function move(price: number, direction: PointAndFigureDirection, boxes: number, size: number, decimals: number) {
  return round(price + (direction === "x" ? 1 : -1) * boxes * size, decimals);
}

function extend(current: PointAndFigureColumn, close: number, boxes: number, candle: Candle) {
  current.close = close;
  current.high = Math.max(current.open, close);
  current.low = Math.min(current.open, close);
  current.boxes += boxes;
  current.volume += candle.volume;
  current.sourceCount += 1;
  current.time = candle.time;
  current.source = candle.source;
}

function column(open: number, close: number, candle: Candle, direction: PointAndFigureDirection, boxSize: number, boxes: number, reversalBoxes: number, volume: number, sourceCount: number): PointAndFigureColumn {
  return {
    time: candle.time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume,
    final: true, source: candle.source, direction, boxSize, boxes, reversalBoxes, sourceCount
  };
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
