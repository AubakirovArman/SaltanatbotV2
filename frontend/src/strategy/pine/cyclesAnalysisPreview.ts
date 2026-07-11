import type { ChartMarker, ChartShapes } from "../../chart/types";
import type { Candle } from "../../types";
import type { StrategyIR } from "../ir";

export interface CyclesAnalysisPreview {
  plots: [];
  signals: ChartMarker[];
  shapes: ChartShapes;
}

/**
 * Native chart preview for the public "Cycles Analysis" Pine script.
 *
 * That script stores its trend state in user-defined objects and arrays, which
 * the portable strategy IR intentionally treats as opaque. Its core reversal
 * algorithm is scalar, though, so reproduce that part here from the imported
 * input values and leave Pine-only tables/prediction objects out of the preview.
 */
export function previewCyclesAnalysis(ir: StrategyIR, candles: Candle[]): CyclesAnalysisPreview | undefined {
  if (!isCyclesAnalysis(ir)) return undefined;

  const input = new Map(ir.inputs.map((item) => [item.name, item.value]));
  const bullPct = positive(input.get("changeInDirectionPercentsInput"), 30);
  const separateBear = truthy(input.get("useSeparatePercentageForBearChangeInput"));
  const bearPct = separateBear
    ? positive(input.get("changeInDirectionPercentsBearInput"), bullPct)
    : bullPct;
  const showBackground = input.get("showBackgroundInput") === undefined || truthy(input.get("showBackgroundInput"));
  const showMarkers = input.get("showReversalDetectionPointInput") === undefined || truthy(input.get("showReversalDetectionPointInput"));
  const useStart = truthy(input.get("useCustomStartRangeInput"));
  const useEnd = truthy(input.get("useCustomEndRangeInput"));
  const start = input.get("rangeStartDateInput") ?? Number.NEGATIVE_INFINITY;
  const end = input.get("rangeEndDateInput") ?? Number.POSITIVE_INFINITY;
  const active = candles.filter((candle) => (!useStart || candle.time >= start) && (!useEnd || candle.time <= end));

  const shapes: ChartShapes = { boxes: [], vlines: [], rays: [] };
  const signals: ChartMarker[] = [];
  if (active.length === 0) return { plots: [], signals, shapes };

  let direction: "bull" | "bear" = "bull";
  let high = active[0].high;
  let highTime = active[0].time;
  let low = active[0].low;
  let lowTime = active[0].time;
  let previousCrestTime = active[0].time;

  const closeCycle = (crestTime: number, color: string, candle: Candle, kind: "buy" | "sell", label: string) => {
    shapes.vlines.push({ time: crestTime, color, label });
    if (showBackground && crestTime >= previousCrestTime) {
      shapes.boxes.push({
        t1: previousCrestTime,
        t2: crestTime,
        top: Number.NaN,
        bottom: Number.NaN,
        color,
        label: ""
      });
    }
    if (showMarkers) {
      signals.push({
        time: candle.time,
        price: kind === "sell" ? candle.high : candle.low,
        kind,
        label
      });
    }
    previousCrestTime = crestTime;
  };

  for (let i = 1; i < active.length; i += 1) {
    const candle = active[i];
    const newHigh = candle.high > high;
    const newLow = candle.low < low;
    if (newHigh) {
      high = candle.high;
      highTime = candle.time;
    }
    if (newLow) {
      low = candle.low;
      lowTime = candle.time;
    }

    if (direction === "bull") {
      if (newHigh) {
        low = candle.low;
        lowTime = candle.time;
      }
      if (!newHigh && candle.low < high * (1 - bearPct / 100)) {
        closeCycle(highTime, "#23c97a", candle, "sell", "Cycle peak");
        direction = "bear";
        high = candle.high;
        highTime = candle.time;
      }
    } else {
      if (newLow) {
        high = candle.high;
        highTime = candle.time;
      }
      if (!newLow && candle.high > low * (1 + bullPct / 100)) {
        closeCycle(lowTime, "#ef5350", candle, "buy", "Cycle trough");
        direction = "bull";
        low = candle.low;
        lowTime = candle.time;
      }
    }
  }

  // Pine extends a line/fill to the last bar for the cycle still in progress.
  if (showBackground && previousCrestTime <= active.at(-1)!.time) {
    shapes.boxes.push({
      t1: previousCrestTime,
      t2: active.at(-1)!.time,
      top: Number.NaN,
      bottom: Number.NaN,
      color: direction === "bull" ? "#23c97a" : "#ef5350",
      label: ""
    });
  }

  return { plots: [], signals, shapes };
}

function isCyclesAnalysis(ir: StrategyIR) {
  const names = new Set(ir.inputs.map((input) => input.name));
  return /cycles analysis/i.test(ir.name) &&
    names.has("changeInDirectionPercentsInput") &&
    names.has("showBackgroundInput");
}

function truthy(value: number | undefined) {
  return value !== undefined && value !== 0;
}

function positive(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
