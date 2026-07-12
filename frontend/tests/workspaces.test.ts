// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureWorkspace,
  encodeWorkspaceFile,
  loadWorkspaces,
  parseWorkspaceFile,
  reviseWorkspace,
  rollbackWorkspace,
  saveWorkspaces,
  WORKSPACE_SCHEMA_VERSION
} from "../src/workspace/workspaces";
import type { WorkspaceChart } from "../src/workspace/workspaces";

const context = {
  symbol: "BTCUSDT",
  timeframe: "1h" as const,
  chartType: "candles" as const,
  cryptoExchange: "binance" as const,
  indicators: [{ id: "ema", label: "EMA", enabled: true, kind: "ema" as const, period: 20, color: "#fff" }],
  compareOverlays: [{ id: "ETHUSDT", symbol: "ETHUSDT", timeframe: "1h" as const, chartType: "line" as const, color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }],
  theme: "dark" as const
};

describe("versioned chart workspaces", () => {
  beforeEach(() => localStorage.clear());

  it("migrates legacy snapshots into the current layout schema", () => {
    localStorage.setItem("sbv2:workspaces", JSON.stringify([{ id: "old", name: "Legacy", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", enabledIndicators: [], createdAt: 10 }]));
    expect(loadWorkspaces()[0]).toMatchObject({
      id: "old",
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: 1,
      cryptoExchange: "binance",
      compareOverlays: [],
      layout: { preset: "single", leftOpen: true, rightOpen: true },
      charts: [{ symbol: "ETHUSDT", linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true }]
    });
  });

  it("autosaves changed state as bounded immutable revisions and rolls back", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const initial = captureWorkspace("Research", context, 100);
    expect(reviseWorkspace(initial, context, 150)).toBe(initial);
    const changed = reviseWorkspace(initial, { ...context, timeframe: "4h", layout: { preset: "split-vertical", leftOpen: false } }, 200);
    expect(changed).toMatchObject({ revision: 2, timeframe: "4h", history: [{ revision: 1, timeframe: "1h" }] });
    const restored = rollbackWorkspace(changed, 1, 300);
    expect(restored).toMatchObject({ revision: 3, timeframe: "1h", updatedAt: 300 });
    saveWorkspaces([restored!]);
    expect(loadWorkspaces()[0]).toMatchObject({ revision: 3, timeframe: "1h" });
  });

  it("round-trips signed export files and rejects checksum tampering", async () => {
    const workspace = captureWorkspace("Portable", context, 100);
    const encoded = await encodeWorkspaceFile(workspace, 200);
    await expect(parseWorkspaceFile(encoded)).resolves.toMatchObject({ name: "Portable", symbol: "BTCUSDT" });
    const tampered = encoded.replace("BTCUSDT", "ETHUSDT");
    await expect(parseWorkspaceFile(tampered)).resolves.toBeUndefined();
  });

  it("preserves price-compressed chart types across local workspace storage", () => {
    const workspace = captureWorkspace("Line Break", { ...context, chartType: "linebreak" }, 100);
    saveWorkspaces([workspace]);
    expect(loadWorkspaces()[0]).toMatchObject({ chartType: "linebreak", charts: [{ chartType: "linebreak" }] });
  });

  it("versions, exports and restores independent pane indicator settings", async () => {
    const charts: WorkspaceChart[] = [
      { id: "chart-1", symbol: "BTCUSDT", timeframe: "1h", chartType: "candles", linkSymbol: true, linkTimeframe: true, linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true },
      { id: "chart-2", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", linkSymbol: false, linkTimeframe: false, linkCrosshair: true, linkTimeRange: true, linkIndicators: false, indicatorOverrides: [{ id: "ema", enabled: true, period: 55 }], linkCompare: false, compareOverlays: [{ id: "SOLUSDT", symbol: "SOLUSDT", timeframe: "1h", chartType: "line", color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }] }
    ];
    const initial = captureWorkspace("Independent indicators", { ...context, charts, layout: { preset: "split-vertical" } }, 100);
    const changedCharts = charts.map((chart) => chart.id === "chart-2" ? { ...chart, indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }] } : chart) as WorkspaceChart[];
    const revised = reviseWorkspace(initial, { ...context, charts: changedCharts, layout: { preset: "split-vertical" } }, 200);
    expect(revised).toMatchObject({ revision: 2, compareOverlays: [{ symbol: "ETHUSDT" }], charts: [{ linkIndicators: true, linkCompare: true }, { linkIndicators: false, indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], linkCompare: false, compareOverlays: [{ symbol: "SOLUSDT" }] }] });
    saveWorkspaces([revised]);
    expect(loadWorkspaces()[0]).toMatchObject({ schemaVersion: 5, charts: [{ linkIndicators: true, linkCompare: true }, { indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], compareOverlays: [{ symbol: "SOLUSDT" }] }] });
    await expect(parseWorkspaceFile(await encodeWorkspaceFile(revised, 250))).resolves.toMatchObject({ charts: [{ linkIndicators: true, linkCompare: true }, { indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], compareOverlays: [{ symbol: "SOLUSDT" }] }] });
    expect(rollbackWorkspace(revised, 1, 300)).toMatchObject({ charts: [{ linkIndicators: true }, { indicatorOverrides: [{ id: "ema", enabled: true, period: 55 }] }] });
  });
});
