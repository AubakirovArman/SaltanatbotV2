import type { Candle } from "../types";
import { priceScale, visibleCandles } from "./scales";
import type { PlotArea, PriceMode, PriceScale, Viewport } from "./types";

export interface ViewportInput {
  candles: Candle[];
  plot: PlotArea;
  zoom: number;
  offset: number;
  priceMode: PriceMode;
  /** Extra price values (indicator lines) that must stay in view. */
  extraValues?: number[];
  /** Optional externally-supplied price scale (e.g. Renko brick scale). */
  scaleOverride?: PriceScale;
}

/**
 * Build the coordinate system for a frame. Everything that needs to place a
 * value on the canvas — renderers, drawings, crosshair, axes, markers — routes
 * through the returned {@link Viewport} so it all stays aligned under zoom/pan.
 */
export function buildViewport(input: ViewportInput): Viewport {
  const { candles, plot, zoom, offset, priceMode, extraValues = [] } = input;
  const visible = visibleCandles(candles, plot, zoom, offset);
  const data = visible.data;
  const barSpacing = visible.step;
  const start = Math.max(0, candles.length - offsetClamped(candles, offset) - data.length);
  const end = start + data.length;

  const scale =
    input.scaleOverride ??
    priceScale(plot, data, extraValues, priceMode, data[0]?.close ?? candles[0]?.close ?? 1);

  const barTimeMs = medianBarTime(candles);
  const lastIndex = candles.length - 1;
  const lastTime = candles[lastIndex]?.time ?? 0;

  const indexToX = (globalIndex: number) =>
    plot.left + (globalIndex - start) * barSpacing + barSpacing / 2;
  const xToIndex = (x: number) => start + (x - plot.left - barSpacing / 2) / barSpacing;

  // Time <-> index uses the last candle as anchor and extrapolates by barTimeMs,
  // which lets drawings/markers sit correctly to the right of the last bar.
  const timeToIndex = (time: number) => lastIndex + (time - lastTime) / barTimeMs;
  const indexToTime = (index: number) => lastTime + (index - lastIndex) * barTimeMs;

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

function offsetClamped(candles: Candle[], offset: number) {
  return Math.max(0, Math.min(offset, Math.max(0, candles.length - 24)));
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
