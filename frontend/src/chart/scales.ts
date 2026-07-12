import type { Candle } from "../types";
import type { PlotArea, PriceMode, PriceScale } from "./types";

export function computePlot(width: number, height: number): PlotArea {
  const left = 12;
  const top = 16;
  const right = width - 74;
  const bottom = height - 30;
  return {
    left,
    top,
    width: Math.max(120, right - left),
    height: Math.max(120, bottom - top),
    right,
    bottom
  };
}

export function visibleCandles(candles: Candle[], plot: PlotArea, zoom: number, offset: number, rightPaddingBars = 0) {
  let step = Math.max(4, Math.min(26, 8 * zoom));
  let count = Math.max(24, Math.floor(plot.width / step));
  let padding = Math.max(0, Math.min(Math.ceil(rightPaddingBars), Math.floor(count * 0.32), Math.max(0, count - 24)));
  if (candles.length > 0 && candles.length + padding < count) {
    step = Math.max(4, Math.min(160, plot.width / Math.max(1, candles.length + padding) * zoom));
    count = Math.max(1, Math.floor(plot.width / step));
    padding = Math.max(0, Math.min(Math.ceil(rightPaddingBars), Math.floor(count * 0.32), Math.max(0, count - 1)));
  }
  const windowCount = Math.max(1, count - padding);
  const minimumVisible = Math.min(candles.length, 24, windowCount);
  const maxOffset = Math.max(0, candles.length - minimumVisible);
  const safeOffset = Math.max(0, Math.min(offset, maxOffset));
  const end = Math.max(0, candles.length - safeOffset);
  const start = Math.max(0, end - windowCount);
  return { data: candles.slice(start, end), step, start, end, maxOffset };
}

export function priceScale(
  plot: PlotArea,
  candles: Candle[],
  extras: number[] = [],
  mode: PriceMode = "linear",
  base = candles[0]?.close ?? 1
): PriceScale {
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const finiteExtras = extras.filter((value) => Number.isFinite(value));
  const rawMax = Math.max(...highs, ...finiteExtras);
  const rawMin = Math.min(...lows, ...finiteExtras);
  const padding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.0005);
  const paddedMax = rawMax + padding;
  const paddedMin = rawMin - padding;

  if (mode === "log" && paddedMin > 0) {
    const maxLog = Math.log(paddedMax);
    const minLog = Math.log(paddedMin);
    const span = maxLog - minLog || 1;
    return {
      min: paddedMin,
      max: paddedMax,
      mode,
      base,
      y: (price: number) => plot.top + ((maxLog - Math.log(Math.max(price, 1e-9))) / span) * plot.height,
      priceAt: (y: number) => Math.exp(maxLog - ((y - plot.top) / plot.height) * span)
    };
  }

  const span = paddedMax - paddedMin || 1;
  return {
    min: paddedMin,
    max: paddedMax,
    mode,
    base,
    y: (price: number) => plot.top + ((paddedMax - price) / span) * plot.height,
    priceAt: (y: number) => paddedMax - ((y - plot.top) / plot.height) * span
  };
}

/**
 * "Nice" axis ticks — round steps of 1/2/2.5/5 × 10ⁿ covering [min, max].
 * For log scales the step is applied in log space so gridlines stay even.
 */
export function niceTicks(min: number, max: number, target = 6, log = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min, max];
  if (log && min > 0) {
    const ticks: number[] = [];
    const minLog = Math.log10(min);
    const maxLog = Math.log10(max);
    const rawStep = (maxLog - minLog) / target;
    const step = Math.max(0.05, roundStep(rawStep));
    for (let l = Math.ceil(minLog / step) * step; l <= maxLog; l += step) {
      ticks.push(10 ** l);
    }
    return ticks.length >= 2 ? ticks : [min, max];
  }
  const step = roundStep((max - min) / target);
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step * 0.001; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

function roundStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const normalized = rough / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}
