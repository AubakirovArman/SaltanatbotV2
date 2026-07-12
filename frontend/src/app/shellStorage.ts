import { normalizeCompareOverlays } from "../chart/compareConfig";
export { asCompareChartType, DEFAULT_COMPARE_DOWN, DEFAULT_COMPARE_UP, MAX_COMPARE } from "../chart/compareConfig";
import type { CompareOverlayConfig } from "../chart/types";
import type { ChartType, DataExchange, Timeframe } from "../types";

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
    return normalizeCompareOverlays(parsed, defaultTimeframe, defaultChartType);
  } catch {
    return [];
  }
}
