import type { Candle } from "../types";
import { priceScale, visibleCandles } from "./scales";
import type { PlotArea, PriceMode, PriceScale, Viewport } from "./types";

export interface ViewportInput {
  candles: Candle[];
  plot: PlotArea;
  zoom: number;
  offset: number;
  priceMode: PriceMode;
  priceZoom?: number;
  /** Extra price values (indicator lines) that must stay in view. */
  extraValues?: number[];
  /** Empty bars reserved to the right for future projection shapes. */
  rightPaddingBars?: number;
  /** Optional externally-supplied price scale (e.g. Renko brick scale). */
  scaleOverride?: PriceScale;
}

/**
 * Build the coordinate system for a frame. Everything that needs to place a
 * value on the canvas — renderers, drawings, crosshair, axes, markers — routes
 * through the returned {@link Viewport} so it all stays aligned under zoom/pan.
 */
export function buildViewport(input: ViewportInput): Viewport {
  const { candles, plot, zoom, offset, priceMode, priceZoom = 1, extraValues = [], rightPaddingBars = 0 } = input;
  const visible = visibleCandles(candles, plot, zoom, offset, rightPaddingBars);
  const data = visible.data;
  const barSpacing = visible.step;
  const { start, end } = visible;

  const scale =
    input.scaleOverride ??
    priceScale(plot, data, extraValues, priceMode, data[0]?.close ?? candles[0]?.close ?? 1, priceZoom);

  const barTimeMs = medianBarTime(candles);
  const lastIndex = candles.length - 1;
  const lastTime = candles[lastIndex]?.time ?? 0;

  const indexToX = (globalIndex: number) =>
    plot.left + (globalIndex - start) * barSpacing + barSpacing / 2;
  const xToIndex = (x: number) => start + (x - plot.left - barSpacing / 2) / barSpacing;

  // Exact candle timestamps map to exact columns. Interpolation keeps drawings
  // aligned across market gaps and compressed price-based representations;
  // median duration is used only for projection beyond the loaded edges.
  const timeToIndex = (time: number) => interpolatedTimeToIndex(candles, time, barTimeMs);
  const indexToTime = (index: number) => interpolatedIndexToTime(candles, index, barTimeMs);

  const timeToX = (time: number) => indexToX(timeToIndex(time));
  const xToTime = (x: number) => indexToTime(xToIndex(x));

  return {
    plot,
    scale,
    barSpacing,
    start,
    end,
    barTimeMs,
    lastTime,
    lastIndex,
    indexToX,
    xToIndex,
    timeToX,
    xToTime,
    priceToY: scale.y,
    yToPrice: scale.priceAt
  };
}

function interpolatedTimeToIndex(candles: readonly Candle[], time: number, fallback: number) {
  if (candles.length === 0) return 0;
  if (time <= candles[0].time) return (time - candles[0].time) / fallback;
  const last = candles.length - 1;
  if (time >= candles[last].time) return last + (time - candles[last].time) / fallback;
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time <= time) low = middle;
    else high = middle;
  }
  const span = candles[high].time - candles[low].time;
  return low + (span > 0 ? (time - candles[low].time) / span : 0);
}

function interpolatedIndexToTime(candles: readonly Candle[], index: number, fallback: number) {
  if (candles.length === 0) return 0;
  const last = candles.length - 1;
  if (index <= 0) return candles[0].time + index * fallback;
  if (index >= last) return candles[last].time + (index - last) * fallback;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return candles[low].time + (candles[high].time - candles[low].time) * (index - low);
}

/** Robust bar duration: median of consecutive time deltas over a sample. */
export function medianBarTime(candles: Candle[]): number {
  if (candles.length < 2) return 60_000;
  const deltas: number[] = [];
  const sampleStart = Math.max(1, candles.length - 60);
  for (let i = sampleStart; i < candles.length; i += 1) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return 60_000;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}
