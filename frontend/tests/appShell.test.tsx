// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { IndicatorConfig } from "../src/chart/indicatorTypes";
import { loadCompare, readPanel } from "../src/app/shellStorage";
import { useAppShell, type AppMode } from "../src/app/useAppShell";
import { useAppCommands } from "../src/app/useAppCommands";
import { LAST_CHART_SESSION_KEY } from "../src/app/chartSession";
import type { CatalogResponse, ChartType, Timeframe } from "../src/types";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0b0d10">';
});

describe("application shell storage", () => {
  it("migrates legacy compare symbols, applies defaults and enforces the cap", () => {
    localStorage.setItem("sbv2:compare", JSON.stringify(["ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]));
    const overlays = loadCompare("15m", "candles");

    expect(overlays).toHaveLength(3);
    expect(overlays[0]).toMatchObject({ id: "ETHUSDT", symbol: "ETHUSDT", timeframe: "15m", chartType: "candles" });
    expect(new Set(overlays.map((overlay) => overlay.color)).size).toBe(3);
  });

  it("falls back safely for malformed storage and missing panel preferences", () => {
    localStorage.setItem("sbv2:compare", "not-json");
    expect(loadCompare("1m", "line")).toEqual([]);
    expect(readPanel("missing", true)).toBe(true);
  });
});

describe("useAppShell", () => {
  it("persists theme and synchronizes native browser color metadata", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1m");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      shell = useAppShell({
        symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType,
        setMode, indicators, setIndicators
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await act(async () => shell?.toggleTheme());

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f2f4f7");
    expect(localStorage.getItem("mf:theme")).toBe("light");
    await act(async () => shell?.setLayoutPreset("grid-4"));
    expect(shell?.charts).toHaveLength(4);
    expect(shell?.charts.every((chart) => chart.linkCrosshair)).toBe(true);
    expect(shell?.charts.every((chart) => chart.linkTimeRange)).toBe(true);
    expect(shell?.charts.every((chart) => chart.linkIndicators)).toBe(true);
    expect(JSON.parse(localStorage.getItem(LAST_CHART_SESSION_KEY) ?? "null")).toMatchObject({ preset: "grid-4", charts: [{ id: "chart-1" }, { id: "chart-2" }, { id: "chart-3" }, { id: "chart-4" }] });
    await act(async () => shell?.setActiveChartId("chart-2"));
    await act(async () => shell?.updateActiveChart({ symbol: "ETHUSDT", timeframe: "5m", chartType: "line" }));
    expect(shell?.activeChart).toMatchObject({ id: "chart-2", symbol: "ETHUSDT", timeframe: "5m", chartType: "line", linkSymbol: false, linkTimeframe: false });
    expect(shell?.charts[0]).toMatchObject({ symbol: "BTCUSDT", timeframe: "1m", chartType: "candles" });
    await act(async () => shell?.setLayoutPreset("split-horizontal"));
    expect(shell?.charts).toHaveLength(2);
    await act(async () => root.unmount());
  });
});

describe("useAppCommands", () => {
  it("owns palette and non-editing timeframe shortcuts", async () => {
    const catalog: CatalogResponse = { instruments: [], timeframes: ["1m", "5m"], chartTypes: ["candles"] };
    const container = document.createElement("div");
    const root = createRoot(container);
    let commands: ReturnType<typeof useAppCommands> | undefined;
    let selectedTimeframe: Timeframe = "1m";

    function Harness() {
      const [, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1m");
      const [, setChartType] = useState<ChartType>("candles");
      const [, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      selectedTimeframe = timeframe;
      commands = useAppCommands({
        catalog, indicators, setIndicators, setSymbol, setTimeframe, setChartType, setMode,
        toggleTheme: () => {}, toggleLeft: () => {}, toggleRight: () => {}, alerts: [], removeAlert: () => {}
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
    expect(commands?.paletteOpen).toBe(true);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" })));
    expect(selectedTimeframe).toBe("5m");
    await act(async () => root.unmount());
  });
});
