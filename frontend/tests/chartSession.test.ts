// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { LAST_CHART_SESSION_KEY, LAST_CHART_SESSION_VERSION, loadLastChartSession, saveLastChartSession } from "../src/app/chartSession";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
import type { WorkspaceChart } from "../src/workspace/workspaces";

const fallback = { symbol: "BTCUSDT", timeframe: "1m" as const, chartType: "candles" as const };
const chart = (id: string, symbol: string, patch: Partial<WorkspaceChart> = {}): WorkspaceChart => ({
  id,
  symbol,
  timeframe: "1m",
  chartType: "candles",
  linkChartType: true,
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
      charts: [expect.objectContaining({ id: "chart-1", symbol: "BTCUSDT", timeZone: "exchange", linkSymbol: true })]
    });
  });

  it("round-trips four independent panes with deterministic ids", () => {
    saveLastChartSession(
      "grid-4",
      [
        chart("primary", "BTCUSDT"),
        chart("duplicate", "ETHUSDT", { timeframe: "5m", exchange: "bybit", marketType: "linear", priceType: "last", timeZone: "Asia/Almaty", linkCrosshair: false, linkIndicators: false, indicatorOverrides: [{ id: "sma-20", enabled: false, period: 55 }] }),
        chart("duplicate", "SOLUSDT", {
          chartType: "line",
          exchange: "binance",
          marketType: "linear",
          priceType: "mark",
          timeZone: "America/New_York",
          linkChartType: false,
          linkCompare: false,
          compareOverlays: [{ id: "ETHUSDT", symbol: "ETHUSDT", timeframe: "15m", chartType: "area", color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }]
        }),
        chart("other", "EURUSD", { linkTimeframe: false })
      ],
      123
    );

    expect(loadLastChartSession(fallback)).toMatchObject({
      version: LAST_CHART_SESSION_VERSION,
      savedAt: 123,
      preset: "grid-4",
      charts: [
        { id: "chart-1", symbol: "BTCUSDT", linkSymbol: true },
        { id: "chart-2", symbol: "ETHUSDT", timeframe: "5m", exchange: "bybit", marketType: "linear", priceType: "last", timeZone: "Asia/Almaty", linkSymbol: false, linkChartType: true, linkCrosshair: false, linkIndicators: false, indicatorOverrides: [{ id: "sma-20", enabled: false, period: 55 }] },
        { id: "chart-3", symbol: "SOLUSDT", chartType: "line", exchange: "binance", marketType: "linear", priceType: "mark", timeZone: "America/New_York", linkChartType: false, linkCompare: false, compareOverlays: [{ symbol: "ETHUSDT", timeframe: "15m", chartType: "area" }] },
        { id: "chart-4", symbol: "EURUSD", linkTimeframe: false }
      ]
    });
  });

  it("migrates a v1 layout and repairs missing or invalid panes", () => {
    localStorage.setItem(
      LAST_CHART_SESSION_KEY,
      JSON.stringify({
        version: 1,
        layoutPreset: "grid-4",
        charts: [
          { id: "bad", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", linkSymbol: false },
          { id: "bad", symbol: "\u0000", timeframe: "invalid", chartType: "invalid" }
        ]
      })
    );
    const restored = loadLastChartSession(fallback);
    expect(restored.preset).toBe("grid-4");
    expect(restored.charts).toHaveLength(4);
    expect(restored.charts[0]).toMatchObject({ id: "chart-1", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", timeZone: "local", linkSymbol: true, linkChartType: true });
    expect(restored.charts[1]).toMatchObject({ id: "chart-2", symbol: "BTCUSDT", timeframe: "1m", chartType: "candles", linkSymbol: false, linkChartType: false, linkIndicators: true, linkCompare: true });
    expect(restored.charts[2]).toMatchObject({ id: "chart-3", linkChartType: true });
    expect(restored.charts[3].id).toBe("chart-4");
  });

  it("fails closed for malformed, oversized and future-version state", () => {
    for (const raw of ["not-json", JSON.stringify({ version: 99, preset: "grid-4", charts: [] }), `"${"x".repeat(64_001)}"`]) {
      localStorage.setItem(LAST_CHART_SESSION_KEY, raw);
      expect(loadLastChartSession(fallback)).toMatchObject({ preset: "single", charts: [{ symbol: "BTCUSDT" }] });
    }
  });

  it("isolates authenticated owners while legacy mode remains unscoped", () => {
    saveLastChartSession("single", [chart("chart-1", "ETHUSDT")], 101, "user-a");
    saveLastChartSession("single", [chart("chart-1", "SOLUSDT")], 102, "user-b");

    expect(loadLastChartSession(fallback, "user-a")).toMatchObject({ savedAt: 101, charts: [{ symbol: "ETHUSDT" }] });
    expect(loadLastChartSession(fallback, "user-b")).toMatchObject({ savedAt: 102, charts: [{ symbol: "SOLUSDT" }] });
    expect(localStorage.getItem(LAST_CHART_SESSION_KEY)).toBeNull();

    saveLastChartSession("single", [chart("chart-1", "EURUSD")], 103);
    expect(loadLastChartSession(fallback)).toMatchObject({ savedAt: 103, charts: [{ symbol: "EURUSD" }] });
  });

  it("allows only one database-auth owner to claim the legacy chart session and fails closed without an owner id", () => {
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "user-a");
    localStorage.setItem(
      LAST_CHART_SESSION_KEY,
      JSON.stringify({
        version: LAST_CHART_SESSION_VERSION,
        savedAt: 77,
        preset: "single",
        charts: [chart("chart-1", "ETHUSDT")]
      })
    );

    expect(loadLastChartSession(fallback, "user-a")).toMatchObject({ savedAt: 77, charts: [{ symbol: "ETHUSDT" }] });
    expect(loadLastChartSession(fallback, "user-b")).toMatchObject({ savedAt: 0, charts: [{ symbol: "BTCUSDT" }] });

    saveLastChartSession("single", [chart("chart-1", "SOLUSDT")], 88, "");
    expect(loadLastChartSession(fallback, "")).toMatchObject({ savedAt: 0, charts: [{ symbol: "BTCUSDT" }] });
    expect(localStorage.getItem(`${LAST_CHART_SESSION_KEY}:`)).toBeNull();
  });
});
