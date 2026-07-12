import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { CompareOverlayConfig } from "../chart/types";
import { loadLocale, localeDirection, storeLocale, type Locale } from "../i18n";
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

export type AppMode = "chart" | "strategy" | "trade";
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
}

export function useAppShell(options: UseAppShellOptions) {
  const [cryptoExchange, setCryptoExchange] = useState<DataExchange>(loadCryptoExchange);
  const [theme, setTheme] = useState<AppTheme>(loadTheme);
  const [locale, setLocale] = useState<Locale>(loadLocale);
  const [leftOpen, setLeftOpen] = useState(() => readPanel("mf:panel:left", true));
  const [rightOpen, setRightOpen] = useState(() => readPanel("mf:panel:right", true));
  const [workspaces, setWorkspaces] = useState(loadWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
  const [layoutPreset, setLayoutPresetState] = useState<ChartLayoutPreset>("single");
  const [charts, setCharts] = useState<WorkspaceChart[]>(() => [{
    id: "chart-1", symbol: options.symbol, timeframe: options.timeframe, chartType: options.chartType,
    linkGroup: "primary", linkSymbol: true, linkTimeframe: true, linkCrosshair: true, linkTimeRange: true
  }]);
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

  useEffect(() => {
    setCharts((current) => current.map((chart, index) => ({
      ...chart,
      symbol: index === 0 || chart.linkSymbol ? options.symbol : chart.symbol,
      timeframe: index === 0 || chart.linkTimeframe ? options.timeframe : chart.timeframe,
      chartType: index === 0 ? options.chartType : chart.chartType
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
          theme,
          layout: { preset: layoutPreset, leftOpen, rightOpen, leftSize, rightSize, panelsSwapped },
          charts
        })
        : workspace));
    }, 750);
    return () => window.clearTimeout(id);
  }, [activeWorkspaceId, charts, cryptoExchange, layoutPreset, leftOpen, leftSize, options.chartType, options.indicators, options.symbol, options.timeframe, panelsSwapped, rightOpen, rightSize, theme]);

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
      theme,
      layout: { preset: layoutPreset, leftOpen, rightOpen, leftSize, rightSize, panelsSwapped },
      charts
    });
    setWorkspaces((current) => [workspace, ...current]);
    setActiveWorkspaceId(workspace.id);
  }, [charts, cryptoExchange, layoutPreset, leftOpen, leftSize, options.chartType, options.indicators, options.symbol, options.timeframe, panelsSwapped, rightOpen, rightSize, theme]);

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
      linkGroup: "primary",
      linkSymbol: index === 0,
      linkTimeframe: true,
      linkCrosshair: true,
      linkTimeRange: true
    }));
  }, [options.chartType, options.symbol, options.timeframe]);

  const updateChart = useCallback((id: string, patch: Partial<WorkspaceChart>) => {
    setCharts((current) => current.map((chart) => {
      if (chart.id !== id) return chart;
      const next = { ...chart, ...patch, id: chart.id };
      if (patch.linkSymbol === true) next.symbol = options.symbol;
      if (patch.linkTimeframe === true) next.timeframe = options.timeframe;
      return next;
    }));
    const chart = charts.find((item) => item.id === id);
    if (!chart) return;
    if (patch.symbol !== undefined && (patch.linkSymbol ?? chart.linkSymbol)) options.setSymbol(patch.symbol);
    if (patch.timeframe !== undefined && (patch.linkTimeframe ?? chart.linkTimeframe)) options.setTimeframe(patch.timeframe);
    if (patch.chartType !== undefined && id === charts[0]?.id) options.setChartType(patch.chartType);
  }, [charts, options.symbol, options.timeframe, options.setChartType, options.setSymbol, options.setTimeframe]);

  return {
    cryptoExchange, setCryptoExchange, theme, locale, leftOpen, rightOpen, leftSize, rightSize, setLeftSize, setRightSize, panelsSwapped, workspaces, activeWorkspaceId, layoutPreset, setLayoutPreset, charts, updateChart,
    compareOverlays, addCompare, updateCompare, removeCompare,
    saveWorkspace, applyWorkspace, deleteWorkspace, exportWorkspace, importWorkspace, rollbackWorkspaceVersion,
    toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
    toggleLocale: () => setLocale((current) => current === "en" ? "ru" : "en"),
    toggleLeft: () => setLeftOpen((current) => !current),
    toggleRight: () => setRightOpen((current) => !current),
    swapPanels: () => setPanelsSwapped((current) => !current)
  };
}
