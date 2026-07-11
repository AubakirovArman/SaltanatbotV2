import { compareColor } from "../chart/compareColors";
import type { CompareChartType, CompareOverlayConfig } from "../chart/types";
import type { ChartType, DataExchange, Timeframe } from "../types";

export const MAX_COMPARE = 3;
export const DEFAULT_COMPARE_UP = "#23c97a";
export const DEFAULT_COMPARE_DOWN = "#ef5350";

export function readPanel(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function writePanel(key: string, open: boolean): void {
  try { window.localStorage.setItem(key, open ? "1" : "0"); } catch { /* runtime state still works */ }
}

export function loadTheme(): "dark" | "light" {
  try { return localStorage.getItem("mf:theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
}

export function loadCryptoExchange(): DataExchange {
  try { return localStorage.getItem("mf:cryptoExchange") === "bybit" ? "bybit" : "binance"; } catch { return "binance"; }
}

/** Load compare overlays while migrating the legacy string[] storage shape. */
export function loadCompare(defaultTimeframe: Timeframe, defaultChartType: ChartType): CompareOverlayConfig[] {
  try {
    const raw = window.localStorage.getItem("sbv2:compare");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index): CompareOverlayConfig | undefined => {
      if (typeof item === "string") return makeCompare(item, index, defaultTimeframe, defaultChartType);
      if (!item || typeof item !== "object") return undefined;
      const candidate = item as Partial<CompareOverlayConfig>;
      if (typeof candidate.symbol !== "string") return undefined;
      return {
        id: typeof candidate.id === "string" ? candidate.id : candidate.symbol,
        symbol: candidate.symbol,
        timeframe: asTimeframe(candidate.timeframe, defaultTimeframe),
        chartType: asCompareChartType(candidate.chartType ?? defaultChartType),
        color: typeof candidate.color === "string" ? candidate.color : compareColor(index),
        upColor: typeof candidate.upColor === "string" ? candidate.upColor : DEFAULT_COMPARE_UP,
        downColor: typeof candidate.downColor === "string" ? candidate.downColor : DEFAULT_COMPARE_DOWN
      };
    }).filter((item): item is CompareOverlayConfig => Boolean(item)).slice(0, MAX_COMPARE);
  } catch {
    return [];
  }
}

export function asCompareChartType(value: unknown): CompareChartType {
  const allowed: CompareChartType[] = ["candles", "heikin", "bars", "line", "area", "baseline"];
  return typeof value === "string" && allowed.includes(value as CompareChartType) ? value as CompareChartType : "line";
}

function asTimeframe(value: unknown, fallback: Timeframe): Timeframe {
  const allowed: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
  return typeof value === "string" && allowed.includes(value as Timeframe) ? value as Timeframe : fallback;
}

function makeCompare(symbol: string, index: number, timeframe: Timeframe, chartType: ChartType): CompareOverlayConfig {
  return {
    id: symbol,
    symbol,
    timeframe,
    chartType: asCompareChartType(chartType),
    color: compareColor(index),
    upColor: DEFAULT_COMPARE_UP,
    downColor: DEFAULT_COMPARE_DOWN
  };
}
