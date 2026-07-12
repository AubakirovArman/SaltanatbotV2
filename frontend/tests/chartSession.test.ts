// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  LAST_CHART_SESSION_KEY,
  LAST_CHART_SESSION_VERSION,
  loadLastChartSession,
  saveLastChartSession
} from "../src/app/chartSession";
import type { WorkspaceChart } from "../src/workspace/workspaces";

const fallback = { symbol: "BTCUSDT", timeframe: "1m" as const, chartType: "candles" as const };
const chart = (id: string, symbol: string, patch: Partial<WorkspaceChart> = {}): WorkspaceChart => ({
  id,
  symbol,
  timeframe: "1m",
  chartType: "candles",
  linkGroup: "primary",
  linkSymbol: false,
  linkTimeframe: true,
  linkCrosshair: true,
  linkTimeRange: true,
  linkIndicators: true,
  linkCompare: true,
  ...patch
});

describe("last chart session", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to one safe primary chart when no state exists", () => {
    expect(loadLastChartSession(fallback)).toEqual({
      version: LAST_CHART_SESSION_VERSION,
      savedAt: 0,
      preset: "single",
      charts: [expect.objectContaining({ id: "chart-1", symbol: "BTCUSDT", linkSymbol: true })]
    });
  });

  it("round-trips four independent panes with deterministic ids", () => {
    saveLastChartSession("grid-4", [
      chart("primary", "BTCUSDT"),
      chart("duplicate", "ETHUSDT", { timeframe: "5m", linkCrosshair: false, linkIndicators: false, indicatorOverrides: [{ id: "sma-20", enabled: false, period: 55 }] }),
      chart("duplicate", "SOLUSDT", { chartType: "line", linkCompare: false, compareOverlays: [{ id: "ETHUSDT", symbol: "ETHUSDT", timeframe: "15m", chartType: "area", color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }] }),
      chart("other", "EURUSD", { linkTimeframe: false })
    ], 123);

    expect(loadLastChartSession(fallback)).toMatchObject({
      version: LAST_CHART_SESSION_VERSION,
      savedAt: 123,
      preset: "grid-4",
      charts: [
        { id: "chart-1", symbol: "BTCUSDT", linkSymbol: true },
        { id: "chart-2", symbol: "ETHUSDT", timeframe: "5m", linkSymbol: false, linkCrosshair: false, linkIndicators: false, indicatorOverrides: [{ id: "sma-20", enabled: false, period: 55 }] },
        { id: "chart-3", symbol: "SOLUSDT", chartType: "line", linkCompare: false, compareOverlays: [{ symbol: "ETHUSDT", timeframe: "15m", chartType: "area" }] },
        { id: "chart-4", symbol: "EURUSD", linkTimeframe: false }
      ]
    });
  });

  it("migrates a v1 layout and repairs missing or invalid panes", () => {
    localStorage.setItem(LAST_CHART_SESSION_KEY, JSON.stringify({
      version: 1,
      layoutPreset: "grid-4",
      charts: [
        { id: "bad", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", linkSymbol: false },
        { id: "bad", symbol: "\u0000", timeframe: "invalid", chartType: "invalid" }
      ]
    }));
    const restored = loadLastChartSession(fallback);
    expect(restored.preset).toBe("grid-4");
    expect(restored.charts).toHaveLength(4);
    expect(restored.charts[0]).toMatchObject({ id: "chart-1", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", linkSymbol: true });
    expect(restored.charts[1]).toMatchObject({ id: "chart-2", symbol: "BTCUSDT", timeframe: "1m", chartType: "candles", linkSymbol: false, linkIndicators: true, linkCompare: true });
    expect(restored.charts[3].id).toBe("chart-4");
  });

  it("fails closed for malformed, oversized and future-version state", () => {
    for (const raw of ["not-json", JSON.stringify({ version: 99, preset: "grid-4", charts: [] }), `"${"x".repeat(64_001)}"`]) {
      localStorage.setItem(LAST_CHART_SESSION_KEY, raw);
      expect(loadLastChartSession(fallback)).toMatchObject({ preset: "single", charts: [{ symbol: "BTCUSDT" }] });
    }
  });
});
