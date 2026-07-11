import type { ChartMarker, ChartShapes, ChartTable } from "../../chart/types";
import type { Candle } from "../../types";
import type { StrategyIR } from "../ir";

type Direction = "bull" | "bear";
type Cycle = { direction: Direction; from: number; to: number; fromPrice: number; toPrice: number; duration: number; change: number };

export interface CyclesAnalysisPreview {
  plots: [];
  signals: ChartMarker[];
  shapes: ChartShapes;
  tables: ChartTable[];
  summary: string;
}

/** Native preview for Cycles Analysis, whose Pine object/array state cannot be
 * represented losslessly in the portable trading IR. */
export function previewCyclesAnalysis(ir: StrategyIR, candles: Candle[]): CyclesAnalysisPreview | undefined {
  if (!isCyclesAnalysis(ir)) return undefined;

  const input = new Map(ir.inputs.map((item) => [item.name, item.value]));
  const bullPct = positive(input.get("changeInDirectionPercentsInput"), 30);
  const separateBear = truthy(input.get("useSeparatePercentageForBearChangeInput"));
  const bearPct = separateBear ? positive(input.get("changeInDirectionPercentsBearInput"), bullPct) : bullPct;
  const showBackground = enabled(input, "showBackgroundInput");
  const showMarkers = enabled(input, "showReversalDetectionPointInput");
  const showLabels = enabled(input, "showLablesInput");
  const showAggregates = enabled(input, "showAggregatesInput");
  const showPrediction = enabled(input, "showPredictionZoneInput");
  const calculatePercentile = enabled(input, "calculatePercentileInput");
  const percentile = Math.min(99, Math.max(1, positive(input.get("percentileInput"), 80)));
  const useStart = truthy(input.get("useCustomStartRangeInput"));
  const useEnd = truthy(input.get("useCustomEndRangeInput"));
  const start = input.get("rangeStartDateInput") ?? Number.NEGATIVE_INFINITY;
  const end = input.get("rangeEndDateInput") ?? Number.POSITIVE_INFINITY;
  const active = candles.filter((candle) => (!useStart || candle.time >= start) && (!useEnd || candle.time <= end));

  const shapes: ChartShapes = { boxes: [], vlines: [], rays: [] };
  const signals: ChartMarker[] = [];
  const tables: ChartTable[] = [];
  if (active.length === 0) return { plots: [], signals, shapes, tables, summary: `0 cycles · ${bullPct}%` };

  const cycles: Cycle[] = [];
  let direction: Direction = "bull";
  let high = active[0].high;
  let highTime = active[0].time;
  let low = active[0].low;
  let lowTime = active[0].time;
  let previousCrestTime = active[0].time;
  let previousCrestPrice = active[0].low;

  const closeCycle = (crestTime: number, crestPrice: number, completedDirection: Direction, color: string, candle: Candle) => {
    const duration = Math.max(0, crestTime - previousCrestTime);
    const change = previousCrestPrice ? Math.abs((crestPrice / previousCrestPrice - 1) * 100) : 0;
    cycles.push({ direction: completedDirection, from: previousCrestTime, to: crestTime, fromPrice: previousCrestPrice, toPrice: crestPrice, duration, change });
    shapes.vlines.push({ time: crestTime, color });
    if (showBackground && crestTime >= previousCrestTime) {
      shapes.boxes.push({ t1: previousCrestTime, t2: crestTime, top: Number.NaN, bottom: Number.NaN, color, label: "", opacity: 0.1, border: false });
    }
    if (showMarkers) signals.push({ time: candle.time, price: candle.low, kind: "marker", color: "#d946ef" });
    if (showLabels) {
      signals.push({
        time: crestTime,
        price: crestPrice,
        kind: completedDirection === "bull" ? "sell" : "buy",
        color,
        label: `${change.toFixed(1)}% · ${formatDuration(duration)}`
      });
    }
    previousCrestTime = crestTime;
    previousCrestPrice = crestPrice;
  };

  for (let i = 1; i < active.length; i += 1) {
    const candle = active[i];
    const newHigh = candle.high > high;
    const newLow = candle.low < low;
    if (newHigh) { high = candle.high; highTime = candle.time; }
    if (newLow) { low = candle.low; lowTime = candle.time; }

    if (direction === "bull") {
      if (newHigh) { low = candle.low; lowTime = candle.time; }
      if (!newHigh && candle.low < high * (1 - bearPct / 100)) {
        closeCycle(highTime, high, "bull", "#23c97a", candle);
        direction = "bear";
        high = candle.high;
        highTime = candle.time;
      }
    } else {
      if (newLow) { high = candle.high; highTime = candle.time; }
      if (!newLow && candle.high > low * (1 + bullPct / 100)) {
        closeCycle(lowTime, low, "bear", "#ef5350", candle);
        direction = "bull";
        low = candle.low;
        lowTime = candle.time;
      }
    }
  }

  if (showBackground && previousCrestTime <= active.at(-1)!.time) {
    shapes.boxes.push({ t1: previousCrestTime, t2: active.at(-1)!.time, top: Number.NaN, bottom: Number.NaN, color: direction === "bull" ? "#23c97a" : "#ef5350", label: "", opacity: 0.1, border: false });
  }

  const bull = cycles.filter((cycle) => cycle.direction === "bull");
  const bear = cycles.filter((cycle) => cycle.direction === "bear");
  const trimmedBull = calculatePercentile ? trimPercentile(bull, percentile) : bull;
  const trimmedBear = calculatePercentile ? trimPercentile(bear, percentile) : bear;
  if (showAggregates) tables.push(cyclesTable(bull, bear, calculatePercentile ? { percentile, bull: trimmedBull, bear: trimmedBear } : undefined));

  const predictionSource = direction === "bull" ? trimmedBull : trimmedBear;
  if (showPrediction && predictionSource.length > 0) {
    const durations = predictionSource.map((cycle) => cycle.duration);
    const changes = predictionSource.map((cycle) => cycle.change);
    const sign = direction === "bull" ? 1 : -1;
    const prices = [Math.min(...changes), Math.max(...changes)].map((change) => previousCrestPrice * (1 + sign * change / 100));
    shapes.boxes.push({
      t1: previousCrestTime + Math.min(...durations),
      t2: previousCrestTime + Math.max(...durations),
      top: Math.max(...prices),
      bottom: Math.min(...prices),
      color: direction === "bull" ? "#23c97a" : "#ef5350",
      label: "Prediction",
      opacity: 0.1
    });
  }

  return { plots: [], signals, shapes, tables, summary: `${cycles.length} cycles · ${bullPct}%` };
}

function cyclesTable(bull: Cycle[], bear: Cycle[], percentileData?: { percentile: number; bull: Cycle[]; bear: Cycle[] }): ChartTable {
  const rows = metricRows(bull, bear);
  if (percentileData) {
    rows.push({ label: `P${percentileData.percentile} periods`, values: [percentileData.bull.length, percentileData.bear.length] });
    rows.push(...metricRows(percentileData.bull, percentileData.bear, `P${percentileData.percentile} `));
  }
  return { id: "Cycles Statistics", columns: ["Bull", "Bear"], rows };
}

function metricRows(bull: Cycle[], bear: Cycle[], prefix = ""): ChartTable["rows"] {
  const durations = (items: Cycle[]) => items.map((item) => item.duration);
  const changes = (items: Cycle[]) => items.map((item) => item.change);
  const pair = (fn: (values: number[]) => number | null, select: (items: Cycle[]) => number[]) => [fn(select(bull)), fn(select(bear))];
  const durationPair = (fn: (values: number[]) => number | null) => pair(fn, durations).map((value) => value === null ? null : formatDuration(value));
  return [
    { label: `${prefix}Periods`, values: [bull.length, bear.length] },
    { label: `${prefix}Shortest`, values: durationPair(min) },
    { label: `${prefix}Longest`, values: durationPair(max) },
    { label: `${prefix}Median duration`, values: durationPair(median) },
    { label: `${prefix}Mean duration`, values: durationPair(mean) },
    { label: `${prefix}Smallest change`, values: pair(min, changes).map(percent) },
    { label: `${prefix}Biggest change`, values: pair(max, changes).map(percent) },
    { label: `${prefix}Median change`, values: pair(median, changes).map(percent) },
    { label: `${prefix}Mean change`, values: pair(mean, changes).map(percent) }
  ];
}

function trimPercentile(items: Cycle[], percentile: number) {
  if (items.length < 3) return [...items];
  const remove = Math.floor(Math.max(1, items.length * (1 - percentile / 100) / 2));
  return [...items].sort((a, b) => a.duration - b.duration).slice(remove, items.length - remove);
}

function isCyclesAnalysis(ir: StrategyIR) {
  const names = new Set(ir.inputs.map((input) => input.name));
  return /cycles analysis/i.test(ir.name) && names.has("changeInDirectionPercentsInput") && names.has("showBackgroundInput");
}

function enabled(input: Map<string, number>, name: string) { return input.get(name) === undefined || truthy(input.get(name)); }
function truthy(value: number | undefined) { return value !== undefined && value !== 0; }
function positive(value: number | undefined, fallback: number) { return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback; }
function min(values: number[]) { return values.length ? Math.min(...values) : null; }
function max(values: number[]) { return values.length ? Math.max(...values) : null; }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function percent(value: number | null) { return value === null ? null : `${value.toFixed(2)}%`; }
function formatDuration(ms: number) {
  const days = ms / 86_400_000;
  if (days >= 365) return `${(days / 365).toFixed(1)}y`;
  if (days >= 30) return `${(days / 30).toFixed(1)}mo`;
  if (days >= 1) return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
