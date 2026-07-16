// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndicatorConfig } from "../src/chart/indicatorTypes";
import { publishDrawingsChanged } from "../src/chart/drawingStore";
import type { DrawingObject } from "../src/chart/drawings";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { loadCompare, readPanel } from "../src/app/shellStorage";
import { useAppShell, type AppMode } from "../src/app/useAppShell";
import { useAppCommands } from "../src/app/useAppCommands";
import { LAST_CHART_SESSION_KEY } from "../src/app/chartSession";
import type { CatalogResponse, ChartType, Timeframe } from "../src/types";
import { captureWorkspace, loadWorkspaces, reviseWorkspace, saveWorkspaces, type WorkspaceStrategySelection } from "../src/workspace/workspaces";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0b0d10">';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
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
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      shell = useAppShell({
        symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType,
        mode, setMode, indicators, setIndicators
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
    expect(shell?.charts.every((chart) => chart.linkCompare)).toBe(true);
    expect(JSON.parse(localStorage.getItem(LAST_CHART_SESSION_KEY) ?? "null")).toMatchObject({ preset: "grid-4", charts: [{ id: "chart-1" }, { id: "chart-2" }, { id: "chart-3" }, { id: "chart-4" }] });
    expect(shell?.setDistinctMarketLayout(["BTCUSDT", "ETHUSDT"])).toBe(false);
    await act(async () => { expect(shell?.setDistinctMarketLayout(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"])).toBe(true); });
    expect(shell?.charts.map((chart) => chart.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
    expect(shell?.charts.map((chart) => chart.linkSymbol)).toEqual([true, false, false, false]);
    expect(shell?.charts.every((chart) => chart.linkTimeframe && chart.linkChartType && chart.linkIndicators && chart.linkCompare)).toBe(true);
    await act(async () => shell?.setActiveChartId("chart-2"));
    await act(async () => shell?.updateActiveChart({ symbol: "ETHUSDT", timeframe: "5m", chartType: "line" }));
    expect(shell?.activeChart).toMatchObject({ id: "chart-2", symbol: "ETHUSDT", timeframe: "5m", chartType: "line", linkSymbol: false, linkTimeframe: false, linkChartType: false });
    expect(shell?.charts[0]).toMatchObject({ symbol: "BTCUSDT", timeframe: "1m", chartType: "candles" });
    await act(async () => shell?.updateChart("chart-2", { linkChartType: true }));
    expect(shell?.activeChart).toMatchObject({ chartType: "candles", linkChartType: true });
    await act(async () => shell?.updateChart("chart-1", { chartType: "line" }));
    expect(shell?.charts.every((chart) => chart.chartType === "line")).toBe(true);
    await act(async () => shell?.updateChart("chart-1", { chartType: "candles" }));
    await act(async () => shell?.setLayoutPreset("split-horizontal"));
    expect(shell?.charts).toHaveLength(2);
    await act(async () => shell?.addCompare("ETHUSDT"));
    expect(shell?.compareOverlays).toMatchObject([{ symbol: "ETHUSDT" }]);
    await act(async () => shell?.saveWorkspace("Compare context"));
    const workspaceId = shell?.workspaces[0]?.id;
    await act(async () => shell?.removeCompare("ETHUSDT"));
    expect(shell?.compareOverlays).toEqual([]);
    await act(async () => { if (workspaceId) shell?.applyWorkspace(workspaceId); });
    expect(shell?.compareOverlays).toEqual([]);
    await act(async () => root.unmount());
  });

  it("duplicates an inactive workspace without activating or overwriting its snapshot", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;
    let setHarnessSymbol: ((symbol: string) => void) | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1h");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      setHarnessSymbol = setSymbol;
      shell = useAppShell({ symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType, mode, setMode, indicators, setIndicators });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => shell?.saveWorkspace("Workspace A"));
    const workspaceA = shell?.workspaces.find((item) => item.name === "Workspace A");
    await act(async () => setHarnessSymbol?.("ETHUSDT"));
    await act(async () => shell?.saveWorkspace("Workspace B"));
    const workspaceB = shell?.workspaces.find((item) => item.name === "Workspace B");
    await act(async () => { if (workspaceA) shell?.applyWorkspace(workspaceA.id); });

    await act(async () => { if (workspaceB) expect(shell?.duplicateWorkspace(workspaceB.id)).toBe(true); });
    expect(shell?.activeWorkspaceId).toBe(workspaceA?.id);
    expect(shell?.workspaces.find((item) => item.name === "Workspace B (copy)")).toMatchObject({ symbol: "ETHUSDT" });
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(shell?.workspaces.find((item) => item.name === "Workspace B (copy)")).toMatchObject({ symbol: "ETHUSDT", revision: 1 });
    await act(async () => root.unmount());
  });

  it("captures active changes immediately for reload, export and same-workspace restore", async () => {
    const selection: WorkspaceStrategySelection = { id: "strategy-live", revision: 3, hash: "12345678", parameters: { period: 55 } };
    const indicator: IndicatorConfig = { id: "ema-live", label: "EMA", kind: "ema", period: 55, color: "#4db6ff", enabled: true };
    const drawing: DrawingObject = { id: "live-line", tool: "hline", points: [{ time: 1, price: 100 }], style: { color: "#fff", width: 1 } };
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;
    let setHarnessSymbol: ((symbol: string) => void) | undefined;
    let setHarnessIndicators: ((indicators: IndicatorConfig[]) => void) | undefined;
    let setHarnessSelection: ((selection: WorkspaceStrategySelection) => void) | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1h");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      const [selectedStrategy, setSelectedStrategy] = useState<WorkspaceStrategySelection>();
      setHarnessSymbol = setSymbol;
      setHarnessIndicators = setIndicators;
      setHarnessSelection = setSelectedStrategy;
      shell = useAppShell({
        symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType, mode, setMode,
        indicators, setIndicators, selectedStrategy
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => shell?.saveWorkspace("Immediate"));
    const id = shell?.activeWorkspaceId;
    await act(async () => {
      setHarnessSymbol?.("ETHUSDT");
      setHarnessIndicators?.([indicator]);
      setHarnessSelection?.(selection);
      shell?.setLayoutPreset("split-horizontal");
    });
    await act(async () => publishDrawingsChanged("ETHUSDT", [drawing], "chart-1"));
    await act(async () => window.dispatchEvent(new Event("pagehide")));

    const immediate = shell?.workspaces.find((workspace) => workspace.id === id);
    expect(immediate).toMatchObject({
      symbol: "ETHUSDT",
      layout: { preset: "split-horizontal" },
      indicators: [{ id: "ema-live", enabled: true }],
      selectedStrategy: selection
    });
    expect(immediate?.drawings.find((scope) => scope.chartId === "chart-1" && scope.symbol === "ETHUSDT")?.drawings).toMatchObject([{ id: "live-line" }]);
    expect(loadWorkspaces().find((workspace) => workspace.id === id)).toMatchObject({
      symbol: "ETHUSDT",
      layout: { preset: "split-horizontal" },
      selectedStrategy: selection
    });

    let exportedBlob: Blob | undefined;
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exportedBlob = blob;
      return "blob:workspace-test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => { if (id) await shell?.exportWorkspace(id); });
    expect(createObjectURL).toHaveBeenCalledOnce();
    const exportedText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exportedBlob!);
    });
    const exported = JSON.parse(exportedText);
    expect(exported.workspace).toMatchObject({ symbol: "ETHUSDT", selectedStrategy: selection });

    await act(async () => { if (id) shell?.applyWorkspace(id); });
    expect(shell?.workspaces.find((workspace) => workspace.id === id)).toMatchObject({
      symbol: "ETHUSDT"
    });
    expect(shell?.workspaces.find((workspace) => workspace.id === id)?.drawings.some((scope) => scope.drawings.some((item) => item.id === "live-line"))).toBe(true);
    await act(async () => root.unmount());
  });

  it("coalesces a drawing drag burst but flushes the exact latest snapshot on pagehide", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1h");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      shell = useAppShell({ symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType, mode, setMode, indicators, setIndicators });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => shell?.saveWorkspace("Drawing burst"));
    const id = shell?.activeWorkspaceId;
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockClear();

    for (let index = 0; index < 20; index += 1) {
      const drawing: DrawingObject = {
        id: `drag-${index}`,
        tool: "hline",
        points: [{ time: index + 1, price: 100 + index }],
        style: { color: "#fff", width: 1 }
      };
      await act(async () => publishDrawingsChanged("BTCUSDT", [drawing], "chart-1"));
    }
    for (let index = 0; index < 20; index += 1) {
      await act(async () => shell?.setRightSize(300 + index));
    }
    expect(setItem.mock.calls.filter(([key]) => key === "sbv2:workspaces")).toHaveLength(0);

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    const persisted = loadWorkspaces().find((workspace) => workspace.id === id);
    expect(persisted).toMatchObject({ revision: 2, history: [{ revision: 1 }], layout: { rightSize: 319 } });
    expect(persisted?.drawings.find((scope) => scope.chartId === "chart-1")?.drawings).toMatchObject([{ id: "drag-19" }]);
    expect(setItem.mock.calls.filter(([key]) => key === "sbv2:workspaces")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("flushes a pending UI edit before immediately preserving a pull conflict as a copy", async () => {
    vi.useFakeTimers();
    const ownerId = "00000000-0000-4000-8000-000000000081";
    const base = captureWorkspace("Conflict source", {
      symbol: "BTCUSDT",
      timeframe: "1h",
      chartType: "candles",
      cryptoExchange: "binance",
      indicators: [],
      theme: "dark"
    }, 100);
    const server = reviseWorkspace(base, {
      symbol: "BTCUSDT",
      timeframe: "4h",
      chartType: "candles",
      cryptoExchange: "binance",
      indicators: [],
      theme: "dark"
    }, 200);
    saveWorkspaces([base], ownerId);

    let resolveList!: (response: Response) => void;
    const listResponse = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(listResponse)
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const auth: AuthContextValue = {
      authRequired: true,
      openAccount: () => undefined,
      refreshSession: async () => undefined,
      tradingRoleAssignmentsEnabled: true,
      tradingAvailable: false,
      user: {
        id: ownerId,
        login: "workspace-owner",
        status: "active",
        appRole: "user",
        tradingRole: "paper-trade",
        mustChangePassword: false,
        authorizationRevision: 1
      }
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;
    let setHarnessSymbol: ((symbol: string) => void) | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1h");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      setHarnessSymbol = setSymbol;
      shell = useAppShell({
        symbol,
        setSymbol,
        timeframe,
        setTimeframe,
        chartType,
        setChartType,
        mode,
        setMode,
        indicators,
        setIndicators
      });
      return null;
    }

    await act(async () =>
      root.render(
        <AuthContext.Provider value={auth}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    await act(async () => shell?.applyWorkspace(base.id));
    await act(async () => setHarnessSymbol?.("ETHUSDT"));

    const remote = {
      id: `document-${base.id}`,
      clientId: base.id,
      revision: 2,
      status: "active",
      archivedAt: null,
      name: server.name,
      schemaVersion: server.schemaVersion,
      payload: server,
      createdAt: new Date(server.createdAt).toISOString(),
      updatedAt: new Date(server.updatedAt).toISOString()
    };
    await act(async () => {
      resolveList(new Response(JSON.stringify({ workspaces: [remote] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(shell?.workspaceSyncStatus.phase).toBe("conflict");

    await act(async () => shell?.resolveWorkspaceConflict("keep-copy"));
    const preserved = shell?.workspaces.find((workspace) => workspace.id !== base.id);
    expect(preserved).toMatchObject({ symbol: "ETHUSDT" });
    expect(shell?.workspaces.find((workspace) => workspace.id === base.id)).toMatchObject({ timeframe: "4h" });

    await act(async () => root.unmount());
  });

  it("preserves an unresolved strategy selection until the user explicitly selects another strategy", async () => {
    vi.useFakeTimers();
    const missing: WorkspaceStrategySelection = { id: "strategy-missing", revision: 7, hash: "abcdef12", parameters: { period: 21 } };
    const replacement: WorkspaceStrategySelection = { id: "strategy-current", revision: 2, hash: "12345678", parameters: { period: 34 } };
    const saved = captureWorkspace("Unresolved strategy", {
      symbol: "BTCUSDT",
      timeframe: "1h",
      chartType: "candles",
      cryptoExchange: "binance",
      indicators: [],
      theme: "dark",
      selectedStrategy: missing
    }, 100);
    saveWorkspaces([saved]);
    const container = document.createElement("div");
    const root = createRoot(container);
    let shell: ReturnType<typeof useAppShell> | undefined;
    let setSelection: ((selection: WorkspaceStrategySelection | undefined) => void) | undefined;

    function Harness() {
      const [symbol, setSymbol] = useState("BTCUSDT");
      const [timeframe, setTimeframe] = useState<Timeframe>("1h");
      const [chartType, setChartType] = useState<ChartType>("candles");
      const [mode, setMode] = useState<AppMode>("chart");
      const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
      const [selectedStrategy, updateSelection] = useState<WorkspaceStrategySelection>();
      setSelection = updateSelection;
      shell = useAppShell({
        symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType, mode, setMode, indicators, setIndicators,
        selectedStrategy,
        onRestoreStrategy: () => "missing"
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => expect(shell?.applyWorkspace(saved.id)).toBe("missing"));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(shell?.workspaces.find((item) => item.id === saved.id)?.selectedStrategy).toEqual(missing);
    expect(shell?.workspaceStrategyRestore).toBe("missing");

    await act(async () => setSelection?.(replacement));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(shell?.workspaces.find((item) => item.id === saved.id)?.selectedStrategy).toEqual(replacement);
    expect(shell?.workspaceStrategyRestore).toBe("none");
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
