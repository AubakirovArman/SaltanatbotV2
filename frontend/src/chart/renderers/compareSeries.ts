import type { Candle } from "../../types";
import { toHeikinAshi } from "../heikinAshi";
import type { ChartTheme, CompareChartType, CompareLegendSnapshot, CompareSeries, Viewport } from "../types";
import {
  drawCompareShape,
  drawPercentAxis,
  drawZeroLine,
  type NormalizedCandle,
  type NormalizedPoint
} from "./compareShapes";

interface CompareInput {
  /** The base chart's visible candles (already sliced to [start, end)). */
  baseVisible: Candle[];
  baseSymbol: string;
  baseColor: string;
  series: CompareSeries[];
  theme: ChartTheme;
}

interface NormalizedCompare {
  id: string;
  symbol: string;
  timeframe: CompareSeries["timeframe"];
  chartType: CompareChartType;
  color: string;
  upColor: string;
  downColor: string;
  line: NormalizedPoint[];
  candles: NormalizedCandle[];
  currentPct?: number;
}

/**
 * Overlays compare symbols on a separate % scale inside the price pane. Each
 * compare can use its own timeframe and display type; values are normalized from
 * the first visible base-chart bar so comparison re-bases while panning.
 */
export function drawCompareSeries(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  input: CompareInput
): CompareLegendSnapshot[] {
  const { plot } = viewport;
  const base = input.baseVisible;
  if (base.length === 0 || input.series.length === 0) return [];

  const baseFirst = base[0]?.close;
  if (!Number.isFinite(baseFirst) || baseFirst === 0) return [];

  const windowStart = base[0].time;
  const windowEnd = base[base.length - 1].time;
  const baseValues = base.map((candle) => (candle.close / baseFirst - 1) * 100);
  const compareItems = input.series
    .map((entry) => normalize(entry, windowStart, windowEnd))
    .filter((entry): entry is NormalizedCompare => entry !== undefined);

  const finite = [
    ...baseValues,
    ...compareItems.flatMap((entry) =>
      entry.candles.length > 0
        ? entry.candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close])
        : entry.line.map((point) => point.value)
    )
  ].filter((value): value is number => Number.isFinite(value));

  if (finite.length === 0) return [];

  let min = Math.min(...finite, 0);
  let max = Math.max(...finite, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const pctToY = (pct: number) => plot.top + ((max - pct) / span) * plot.height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();

  drawZeroLine(ctx, plot, pctToY, input.theme);
  for (const entry of compareItems) {
    drawCompareShape(ctx, viewport, entry, pctToY);
  }
  ctx.restore();

  drawPercentAxis(ctx, plot, min, max, pctToY, input.theme);
  ctx.lineWidth = 1;

  return [
    { id: "base", symbol: input.baseSymbol, color: input.baseColor, pct: lastDefined(baseValues), base: true },
    ...compareItems.map((entry) => ({
      id: entry.id,
      symbol: entry.symbol,
      color: entry.color,
      pct: entry.currentPct,
      base: false,
      timeframe: entry.timeframe,
      chartType: entry.chartType
    }))
  ];
}

function normalize(entry: CompareSeries, windowStart: number, windowEnd: number): NormalizedCompare | undefined {
  if (entry.candles.length === 0) return undefined;

  const source = entry.chartType === "heikin" ? toHeikinAshi(entry.candles) : entry.candles;
  const anchor = nearestBefore(source, windowStart) ?? source.find((candle) => candle.time >= windowStart);
  const baseline = anchor?.close;
  if (!baseline || !Number.isFinite(baseline)) return undefined;

  const inWindow = source.filter((candle) => candle.time >= windowStart && candle.time <= windowEnd);
  const line = normalizeLine(source, baseline, windowStart, windowEnd);
  const candles = inWindow.map((candle) => ({
    time: candle.time,
    open: pct(candle.open, baseline),
    high: pct(candle.high, baseline),
    low: pct(candle.low, baseline),
    close: pct(candle.close, baseline)
  }));
  const last = nearestBefore(source, windowEnd) ?? inWindow.at(-1);

  return {
    id: entry.id,
    symbol: entry.symbol,
    timeframe: entry.timeframe,
    chartType: entry.chartType,
    color: entry.color,
    upColor: entry.upColor,
    downColor: entry.downColor,
    line,
    candles,
    currentPct: last ? pct(last.close, baseline) : undefined
  };
}

function normalizeLine(candles: Candle[], baseline: number, windowStart: number, windowEnd: number): NormalizedPoint[] {
  const points: NormalizedPoint[] = [];
  const before = nearestBefore(candles, windowStart);
  if (before) points.push({ time: windowStart, value: pct(before.close, baseline) });
  for (const candle of candles) {
    if (candle.time < windowStart || candle.time > windowEnd) continue;
    points.push({ time: candle.time, value: pct(candle.close, baseline) });
  }
  const atEnd = nearestBefore(candles, windowEnd);
  if (atEnd && (points.length === 0 || points[points.length - 1].time < windowEnd)) {
    points.push({ time: windowEnd, value: pct(atEnd.close, baseline) });
  }
  return dedupePoints(points);
}

/** Latest candle close at or before `time` (candles assumed time-ascending). */
function nearestBefore(candles: Candle[], time: number): Candle | undefined {
  let result: Candle | undefined;
  for (const candle of candles) {
    if (candle.time > time) break;
    result = candle;
  }
  return result;
}

function dedupePoints(points: NormalizedPoint[]): NormalizedPoint[] {
  const out: NormalizedPoint[] = [];
  for (const point of points) {
    if (out.at(-1)?.time === point.time) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

function lastDefined(values: number[]): number | undefined {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return undefined;
}

function pct(value: number, baseline: number) {
  return (value / baseline - 1) * 100;
}
