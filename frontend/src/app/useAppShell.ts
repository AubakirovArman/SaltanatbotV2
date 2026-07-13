import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { CompareOverlayConfig } from "../chart/types";
import { loadLocale, localeDirection, nextLocale, storeLocale, type Locale } from "../i18n";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import { storeIndicators } from "../strategy/storage";
import type { ChartType, DataExchange, Timeframe } from "../types";
import {
  applyIndicatorSelection,
  captureWorkspace,
  downloadWorkspaceFile,
  loadWorkspaces,
  parseWorkspaceFile,
  reviseWorkspace,
  rollbackWorkspace,
  saveWorkspaces,
  type ChartLayoutPreset,
  type WorkspaceChart
} from "../workspace/workspaces";
import {
  asCompareChartType,
  DEFAULT_COMPARE_DOWN,
  DEFAULT_COMPARE_UP,
  loadCompare,
  loadCryptoExchange,
  loadTheme,
  MAX_COMPARE,
  readPanel,
  writePanel
} from "./shellStorage";
import { compareColor } from "../chart/compareColors";
import { loadLastChartSession, saveLastChartSession, type LastChartSession } from "./chartSession";
import { normalizeDistinctMarketSymbols } from "./distinctMarkets";

export type AppMode = "chart" | "strategy" | "trade" | "screener";
export type AppTheme = "dark" | "light";

interface UseAppShellOptions {
  symbol: string;
  setSymbol: Dispatch<SetStateAction<string>>;
  timeframe: Timeframe;
  setTimeframe: Dispatch<SetStateAction<Timeframe>>;
  chartType: ChartType;
  setChartType: Dispatch<SetStateAction<ChartType>>;
  setMode: Dispatch<SetStateAction<AppMode>>;
  indicators: IndicatorConfig[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  initialChartSession?: LastChartSession;
}

export function useAppShell(options: UseAppShellOptions) {
  const [initialChartSession] = useState(() => options.initialChartSession ?? loadLastChartSession({ symbol: options.symbol, timeframe: options.timeframe, chartType: options.chartType }));
  const [cryptoExchange, setCryptoExchange] = useState<DataExchange>(loadCryptoExchange);
  const [theme, setTheme] = useState<AppTheme>(loadTheme);
  const [locale, setLocale] = useState<Locale>(loadLocale);
  const [leftOpen, setLeftOpen] = useState(() => readPanel("mf:panel:left", true));
  const [rightOpen, setRightOpen] = useState(() => readPanel("mf:panel:right", true));
  const [workspaces, setWorkspaces] = useState(loadWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
  const [layoutPreset, setLayoutPresetState] = useState<ChartLayoutPreset>(initialChartSession.preset);
  const [charts, setCharts] = useState<WorkspaceChart[]>(initialChartSession.charts);
  const [activeChartId, setActiveChartId] = useState(initialChartSession.charts[0]?.id);
  const [leftSize, setLeftSize] = useState(260);
  const [rightSize, setRightSize] = useState(280);
  const [panelsSwapped, setPanelsSwapped] = useState(false);
  const [compareOverlays, setCompareOverlays] = useState<CompareOverlayConfig[]>(() => loadCompare(options.timeframe, options.chartType));

  useEffect(() => saveWorkspaces(workspaces), [workspaces]);
  useEffect(() => { try { localStorage.setItem("mf:cryptoExchange", cryptoExchange); } catch { /* noop */ } }, [cryptoExchange]);
  useEffect(() => writePanel("mf:panel:left", leftOpen), [leftOpen]);
  useEffect(() => writePanel("mf:panel:right", rightOpen), [rightOpen]);
  useEffect(() => { try { localStorage.setItem("sbv2:compare", JSON.stringify(compareOverlays)); } catch { /* noop */ } }, [compareOverlays]);
  useEffect(() => storeIndicators(options.indicators), [options.indicators]);
  useEffect(() => saveLastChartSession(layoutPreset, charts), [charts, layoutPreset]);

  useEffect(() => {
    if (!charts.some((chart) => chart.id === activeChartId)) setActiveChartId(charts[0]?.id);
  }, [activeChartId, charts]);

  useEffect(() => {
    setCharts((current) => current.map((chart, index) => ({
      ...chart,
      symbol: index === 0 || chart.linkSymbol ? options.symbol : chart.symbol,
      timeframe: index === 0 || chart.linkTimeframe ? options.timeframe : chart.timeframe,
      chartType: index === 0 || chart.linkChartType ? options.chartType : chart.chartType
    })));
  }, [options.chartType, options.symbol, options.timeframe]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const id = window.setTimeout(() => {
      setWorkspaces((current) => current.map((workspace) => workspace.id === activeWorkspaceId
        ? reviseWorkspace(workspace, {
          symbol: options.symbol,
          timeframe: options.timeframe,
          chartType: options.chartType,
          cryptoExchange,
          indicators: options.indicators,
          compareOverlays,
          theme,
          layout: { preset: layoutPreset, leftOpen, rightOpen, leftSize, rightSize, panelsSwapped },
          charts
        })
        : workspace));
    }, 750);
    return () => window.clearTimeout(id);
  }, [activeWorkspaceId, charts, compareOverlays, cryptoExchange, layoutPreset, leftOpen, leftSize, options.chartType, options.indicators, options.symbol, options.timeframe, panelsSwapped, rightOpen, rightSize, theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d10" : "#f2f4f7");
    try { localStorage.setItem("mf:theme", theme); } catch { /* noop */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
    storeLocale(locale);
  }, [locale]);

  useEffect(() => {
    const id = window.setTimeout(() => warmStrategyLab(), 1800);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    setCompareOverlays((current) => current.some((item) => item.symbol === options.symbol)
      ? current.filter((item) => item.symbol !== options.symbol)
      : current);
  }, [options.symbol]);

  const addCompare = useCallback((symbol: string) => {
    setCompareOverlays((current) => current.some((item) => item.symbol === symbol) || current.length >= MAX_COMPARE
      ? current
      : [...current, {
        id: symbol,
        symbol,
        timeframe: options.timeframe,
        chartType: asCompareChartType(options.chartType),
        color: compareColor(current.length),
        upColor: DEFAULT_COMPARE_UP,
        downColor: DEFAULT_COMPARE_DOWN
      }]);
  }, [options.chartType, options.timeframe]);

  const updateCompare = useCallback((id: string, patch: Partial<CompareOverlayConfig>) => {
    setCompareOverlays((current) => current.map((item) => item.id === id
      ? { ...item, ...patch, chartType: asCompareChartType(patch.chartType ?? item.chartType) }
      : item));
  }, []);
  const removeCompare = useCallback((id: string) => setCompareOverlays((current) => current.filter((item) => item.id !== id)), []);

  const saveWorkspace = useCallback((name: string) => {
    const workspace = captureWorkspace(name, {
      symbol: options.symbol,
      timeframe: options.timeframe,
      chartType: options.chartType,
      cryptoExchange,
      indicators: options.indicators,
      compareOverlays,
      theme,
      layout: { preset: layoutPreset, leftOpen, rightOpen, leftSize, rightSize, panelsSwapped },
      charts
    });
    setWorkspaces((current) => [workspace, ...current]);
    setActiveWorkspaceId(workspace.id);
  }, [charts, compareOverlays, cryptoExchange, layoutPreset, leftOpen, leftSize, options.chartType, options.indicators, options.symbol, options.timeframe, panelsSwapped, rightOpen, rightSize, theme]);

  const applyWorkspace = useCallback((id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    options.setSymbol(workspace.symbol);
    options.setTimeframe(workspace.timeframe);
    options.setChartType(workspace.chartType);
    setCryptoExchange(workspace.cryptoExchange);
    setTheme(workspace.theme);
    setLeftOpen(workspace.layout.leftOpen);
    setRightOpen(workspace.layout.rightOpen);
    setLayoutPresetState(workspace.layout.preset);
    setCharts(workspace.charts);
    setCompareOverlays(workspace.compareOverlays);
    setLeftSize(workspace.layout.leftSize);
    setRightSize(workspace.layout.rightSize);
    setPanelsSwapped(workspace.layout.panelsSwapped);
    options.setIndicators((current) => applyIndicatorSelection(current, workspace.enabledIndicators));
    options.setMode("chart");
    setActiveWorkspaceId(workspace.id);
  }, [options.setChartType, options.setIndicators, options.setMode, options.setSymbol, options.setTimeframe, workspaces]);

  const deleteWorkspace = useCallback((id: string) => {
    setWorkspaces((current) => current.filter((item) => item.id !== id));
    setActiveWorkspaceId((current) => current === id ? undefined : current);
  }, []);

  const exportWorkspace = useCallback((id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    return workspace ? downloadWorkspaceFile(workspace) : Promise.resolve();
  }, [workspaces]);

  const importWorkspace = useCallback(async (raw: string) => {
    const parsed = await parseWorkspaceFile(raw);
    if (!parsed) return false;
    const duplicate = workspaces.some((workspace) => workspace.id === parsed.id);
    const workspace = duplicate ? { ...parsed, id: `${parsed.id}-import-${Date.now()}` } : parsed;
    setWorkspaces((current) => [workspace, ...current]);
    return true;
  }, [workspaces]);

  const rollbackWorkspaceVersion = useCallback((id: string, revision: number) => {
    const workspace = workspaces.find((item) => item.id === id);
    const next = workspace ? rollbackWorkspace(workspace, revision) : undefined;
    if (!next) return false;
    setWorkspaces((current) => current.map((item) => item.id === id ? next : item));
    options.setSymbol(next.symbol);
    options.setTimeframe(next.timeframe);
    options.setChartType(next.chartType);
    setCryptoExchange(next.cryptoExchange);
    setTheme(next.theme);
    setLeftOpen(next.layout.leftOpen);
    setRightOpen(next.layout.rightOpen);
    setLeftSize(next.layout.leftSize);
    setRightSize(next.layout.rightSize);
    setPanelsSwapped(next.layout.panelsSwapped);
    setLayoutPresetState(next.layout.preset);
    setCharts(next.charts);
    setCompareOverlays(next.compareOverlays);
    options.setIndicators((current) => applyIndicatorSelection(current, next.enabledIndicators));
    options.setMode("chart");
    setActiveWorkspaceId(next.id);
    return true;
  }, [options.setChartType, options.setIndicators, options.setMode, options.setSymbol, options.setTimeframe, workspaces]);

  const setLayoutPreset = useCallback((preset: ChartLayoutPreset) => {
    setLayoutPresetState(preset);
    const count = preset === "single" ? 1 : preset === "grid-4" ? 4 : 2;
    setCharts((current) => Array.from({ length: count }, (_, index) => current[index] ?? {
      id: `chart-${index + 1}`,
      symbol: options.symbol,
      timeframe: options.timeframe,
      chartType: options.chartType,
      linkChartType: true,
      linkGroup: "primary",
      linkSymbol: index === 0,
      linkTimeframe: true,
      linkCrosshair: true,
      linkTimeRange: true,
      linkIndicators: true,
      linkCompare: true
    }));
  }, [options.chartType, options.symbol, options.timeframe]);

  const setDistinctMarketLayout = useCallback((symbols: string[]) => {
    const distinct = normalizeDistinctMarketSymbols(options.symbol, symbols, 4);
    if (distinct.length < 4) return false;
    setLayoutPresetState("grid-4");
    setCharts((current) => Array.from({ length: 4 }, (_, index) => {
      const chart = current[index] ?? {
        id: `chart-${index + 1}`, symbol: options.symbol, timeframe: options.timeframe, chartType: options.chartType,
        linkGroup: "primary", linkSymbol: index === 0, linkTimeframe: true, linkChartType: true, linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true
      };
      const symbol = distinct[index];
      return { ...chart, symbol, linkSymbol: index === 0, compareOverlays: chart.linkCompare ? undefined : chart.compareOverlays?.filter((overlay) => overlay.symbol !== symbol) };
    }));
    return true;
  }, [options.chartType, options.symbol, options.timeframe]);

  const updateChart = useCallback((id: string, patch: Partial<WorkspaceChart>) => {
    setCharts((current) => current.map((chart) => {
      if (chart.id !== id) return chart;
      const next = { ...chart, ...patch, id: chart.id };
      if (patch.linkSymbol === true) next.symbol = options.symbol;
      if (patch.linkTimeframe === true) next.timeframe = options.timeframe;
      if (patch.linkChartType === true) next.chartType = options.chartType;
      if (patch.linkIndicators === true) next.indicatorOverrides = undefined;
      if (patch.linkCompare === true) next.compareOverlays = undefined;
      if (patch.symbol !== undefined && next.compareOverlays) next.compareOverlays = next.compareOverlays.filter((overlay) => overlay.symbol !== patch.symbol);
      return next;
    }));
    const chart = charts.find((item) => item.id === id);
    if (!chart) return;
    if (patch.symbol !== undefined && (patch.linkSymbol ?? chart.linkSymbol)) options.setSymbol(patch.symbol);
    if (patch.timeframe !== undefined && (patch.linkTimeframe ?? chart.linkTimeframe)) options.setTimeframe(patch.timeframe);
    if (patch.chartType !== undefined && id === charts[0]?.id) options.setChartType(patch.chartType);
  }, [charts, options.symbol, options.timeframe, options.setChartType, options.setSymbol, options.setTimeframe]);

  const updateActiveChart = useCallback((patch: Partial<WorkspaceChart>) => {
    const chart = charts.find((item) => item.id === activeChartId) ?? charts[0];
    if (!chart) return;
    const independentPatch = chart.id === charts[0]?.id ? patch : {
      ...patch,
      ...(patch.symbol === undefined ? {} : { linkSymbol: false }),
      ...(patch.timeframe === undefined ? {} : { linkTimeframe: false }),
      ...(patch.chartType === undefined ? {} : { linkChartType: false })
    };
    updateChart(chart.id, independentPatch);
  }, [activeChartId, charts, updateChart]);

  const activeChart = charts.find((chart) => chart.id === activeChartId) ?? charts[0];

  return {
    cryptoExchange, setCryptoExchange, theme, locale, leftOpen, rightOpen, leftSize, rightSize, setLeftSize, setRightSize, panelsSwapped, workspaces, activeWorkspaceId, layoutPreset, setLayoutPreset, setDistinctMarketLayout, charts, activeChart, activeChartId, setActiveChartId, updateChart, updateActiveChart,
    compareOverlays, addCompare, updateCompare, removeCompare,
    saveWorkspace, applyWorkspace, deleteWorkspace, exportWorkspace, importWorkspace, rollbackWorkspaceVersion,
    toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
    toggleLocale: () => setLocale(nextLocale),
    toggleLeft: () => setLeftOpen((current) => !current),
    toggleRight: () => setRightOpen((current) => !current),
    swapPanels: () => setPanelsSwapped((current) => !current)
  };
}
