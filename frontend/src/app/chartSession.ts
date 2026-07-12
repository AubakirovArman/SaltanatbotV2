import type { ChartType, Timeframe } from "../types";
import type { ChartLayoutPreset, WorkspaceChart } from "../workspace/workspaces";
import { normalizePaneIndicatorOverrides } from "../chart/paneIndicators";
import { normalizeCompareOverlays } from "../chart/compareConfig";

export const LAST_CHART_SESSION_KEY = "sbv2:last-chart-session:v1";
export const LAST_CHART_SESSION_VERSION = 3;
const MAX_SESSION_BYTES = 64_000;
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
const CHART_TYPES: ChartType[] = ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"];

export interface ChartSessionFallback {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
}

export interface LastChartSession {
  version: typeof LAST_CHART_SESSION_VERSION;
  savedAt: number;
  preset: ChartLayoutPreset;
  charts: WorkspaceChart[];
}

export function loadLastChartSession(fallback: ChartSessionFallback): LastChartSession {
  try {
    const raw = localStorage.getItem(LAST_CHART_SESSION_KEY);
    if (!raw || raw.length > MAX_SESSION_BYTES) return defaultSession(fallback);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultSession(fallback);
    const item = parsed as Record<string, unknown>;
    if (item.version !== undefined && item.version !== 1 && item.version !== 2 && item.version !== LAST_CHART_SESSION_VERSION) return defaultSession(fallback);
    const preset = normalizePreset(item.preset ?? item.layoutPreset ?? (item.layout as Record<string, unknown> | undefined)?.preset);
    const count = chartCount(preset);
    const source = Array.isArray(item.charts) ? item.charts : [];
    const charts = Array.from({ length: count }, (_, index) => normalizeChart(source[index], index, fallback));
    return { version: LAST_CHART_SESSION_VERSION, savedAt: finiteNumber(item.savedAt, 0), preset, charts };
  } catch {
    return defaultSession(fallback);
  }
}

export function saveLastChartSession(preset: ChartLayoutPreset, charts: WorkspaceChart[], now = Date.now()): void {
  try {
    const count = chartCount(preset);
    if (charts.length < count) return;
    const session: LastChartSession = {
      version: LAST_CHART_SESSION_VERSION,
      savedAt: now,
      preset,
      charts: charts.slice(0, count).map((chart, index) => ({ ...chart, id: `chart-${index + 1}`, linkSymbol: index === 0 ? true : chart.linkSymbol, indicatorOverrides: chart.linkIndicators ? undefined : chart.indicatorOverrides?.map((override) => ({ ...override })), compareOverlays: chart.linkCompare ? undefined : chart.compareOverlays?.map((overlay) => ({ ...overlay })) }))
    };
    localStorage.setItem(LAST_CHART_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Runtime state remains usable when storage is unavailable or full.
  }
}

function defaultSession(fallback: ChartSessionFallback): LastChartSession {
  return { version: LAST_CHART_SESSION_VERSION, savedAt: 0, preset: "single", charts: [normalizeChart(undefined, 0, fallback)] };
}

function normalizePreset(value: unknown): ChartLayoutPreset {
  return value === "split-vertical" || value === "split-horizontal" || value === "grid-4" ? value : "single";
}

function chartCount(preset: ChartLayoutPreset): number {
  return preset === "single" ? 1 : preset === "grid-4" ? 4 : 2;
}

function normalizeChart(value: unknown, index: number, fallback: ChartSessionFallback): WorkspaceChart {
  const item = value && typeof value === "object" ? value as Partial<WorkspaceChart> : {};
  const linkIndicators = item.linkIndicators !== false;
  const linkCompare = item.linkCompare !== false;
  const timeframe = TIMEFRAMES.includes(item.timeframe as Timeframe) ? item.timeframe as Timeframe : fallback.timeframe;
  const chartType = CHART_TYPES.includes(item.chartType as ChartType) ? item.chartType as ChartType : fallback.chartType;
  return {
    id: `chart-${index + 1}`,
    symbol: validSymbol(item.symbol) ? item.symbol : fallback.symbol,
    timeframe,
    chartType,
    linkGroup: "primary",
    linkSymbol: index === 0 ? true : item.linkSymbol === true,
    linkTimeframe: item.linkTimeframe !== false,
    linkCrosshair: item.linkCrosshair !== false,
    linkTimeRange: item.linkTimeRange !== false,
    linkIndicators,
    indicatorOverrides: linkIndicators ? undefined : normalizePaneIndicatorOverrides(item.indicatorOverrides),
    linkCompare,
    compareOverlays: linkCompare ? undefined : normalizeCompareOverlays(item.compareOverlays, timeframe, chartType)
  };
}

function validSymbol(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= 64
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
