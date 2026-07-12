import type { Candle } from "../types";
import { visibleCandles } from "./scales";
import type { LinkedTimeRange, Viewport } from "./types";

export interface LinkedNavigationView {
  zoom: number;
  offset: number;
}

/** Convert the prepared viewport into a transportable absolute UTC range. */
export function linkedRangeFromViewport(viewport: Viewport, sourceId: string): LinkedTimeRange | undefined {
  if (viewport.end <= viewport.start) return undefined;
  const startTime = viewport.xToTime(viewport.indexToX(viewport.start));
  const endTime = viewport.xToTime(viewport.indexToX(viewport.end - 1));
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return undefined;
  return { sourceId, startTime, endTime };
}

/** Map an absolute range to this series; refuse ranges fully outside loaded history. */
export function viewForLinkedRange(candles: readonly Candle[], viewport: Viewport, range: LinkedTimeRange): LinkedNavigationView | undefined {
  if (candles.length === 0 || range.endTime < candles[0].time || range.startTime > candles.at(-1)!.time) return undefined;
  const start = firstAtOrAfter(candles, range.startTime);
  const end = lastAtOrBefore(candles, range.endTime);
  if (end < start) return undefined;
  const desiredCount = Math.max(1, end - start + 1);
  const zoom = clamp(viewport.plot.width / (Math.max(24, desiredCount) * 8), 0.4, 4);
  const visible = visibleCandles(candles, viewport.plot, zoom, 0);
  const offset = clamp(candles.length - 1 - end, 0, visible.maxOffset);
  return { zoom: Number(zoom.toFixed(4)), offset: Math.round(offset) };
}

function firstAtOrAfter(candles: readonly Candle[], time: number) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return Math.min(candles.length - 1, low);
}

function lastAtOrBefore(candles: readonly Candle[], time: number) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
