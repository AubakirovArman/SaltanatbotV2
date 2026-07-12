import type { ChartType, Timeframe } from "../types";
import { compareColor } from "./compareColors";
import type { CompareChartType, CompareOverlayConfig } from "./types";

export const MAX_COMPARE = 3;
export const DEFAULT_COMPARE_UP = "#23c97a";
export const DEFAULT_COMPARE_DOWN = "#ef5350";
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
const CHART_TYPES: CompareChartType[] = ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline"];

export function createCompareOverlay(symbol: string, index: number, timeframe: Timeframe, chartType: ChartType): CompareOverlayConfig {
  return { id: symbol, symbol, timeframe, chartType: asCompareChartType(chartType), color: compareColor(index), upColor: DEFAULT_COMPARE_UP, downColor: DEFAULT_COMPARE_DOWN };
}

export function normalizeCompareOverlays(value: unknown, fallbackTimeframe: Timeframe, fallbackChartType: ChartType): CompareOverlayConfig[] {
  if (!Array.isArray(value)) return [];
  const result: CompareOverlayConfig[] = [];
  const symbols = new Set<string>();
  const ids = new Set<string>();
  for (const entry of value) {
    const candidate = typeof entry === "string" ? createCompareOverlay(entry, result.length, fallbackTimeframe, fallbackChartType) : normalizeEntry(entry, result.length, fallbackTimeframe, fallbackChartType);
    if (!candidate || symbols.has(candidate.symbol) || ids.has(candidate.id)) continue;
    symbols.add(candidate.symbol);
    ids.add(candidate.id);
    result.push(candidate);
    if (result.length === MAX_COMPARE) break;
  }
  return result;
}

export function asCompareChartType(value: unknown): CompareChartType {
  return typeof value === "string" && CHART_TYPES.includes(value as CompareChartType) ? value as CompareChartType : "line";
}

function normalizeEntry(value: unknown, index: number, fallbackTimeframe: Timeframe, fallbackChartType: ChartType): CompareOverlayConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<CompareOverlayConfig>;
  if (!safeSymbol(item.symbol)) return undefined;
  return {
    id: safeId(item.id) ?? item.symbol,
    symbol: item.symbol,
    timeframe: TIMEFRAMES.includes(item.timeframe as Timeframe) ? item.timeframe as Timeframe : fallbackTimeframe,
    chartType: asCompareChartType(item.chartType ?? fallbackChartType),
    color: safeColor(item.color) ?? compareColor(index),
    upColor: safeColor(item.upColor) ?? DEFAULT_COMPARE_UP,
    downColor: safeColor(item.downColor) ?? DEFAULT_COMPARE_DOWN
  };
}

function safeSymbol(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && value.trim() === value
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function safeId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? value : undefined;
}

function safeColor(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}
