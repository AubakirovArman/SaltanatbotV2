import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { CompareOverlayConfig } from "../chart/types";
import { loadLocale, storeLocale, type Locale } from "../i18n";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import { storeIndicators } from "../strategy/storage";
import type { ChartType, DataExchange, Timeframe } from "../types";
import { applyIndicatorSelection, captureWorkspace, loadWorkspaces, saveWorkspaces } from "../workspace/workspaces";
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
  const [compareOverlays, setCompareOverlays] = useState<CompareOverlayConfig[]>(() => loadCompare(options.timeframe, options.chartType));

  useEffect(() => saveWorkspaces(workspaces), [workspaces]);
  useEffect(() => { try { localStorage.setItem("mf:cryptoExchange", cryptoExchange); } catch { /* noop */ } }, [cryptoExchange]);
  useEffect(() => writePanel("mf:panel:left", leftOpen), [leftOpen]);
  useEffect(() => writePanel("mf:panel:right", rightOpen), [rightOpen]);
  useEffect(() => { try { localStorage.setItem("sbv2:compare", JSON.stringify(compareOverlays)); } catch { /* noop */ } }, [compareOverlays]);
  useEffect(() => storeIndicators(options.indicators), [options.indicators]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d10" : "#f2f4f7");
    try { localStorage.setItem("mf:theme", theme); } catch { /* noop */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
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
      theme
    });
    setWorkspaces((current) => [workspace, ...current]);
  }, [cryptoExchange, options.chartType, options.indicators, options.symbol, options.timeframe, theme]);

  const applyWorkspace = useCallback((id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    options.setSymbol(workspace.symbol);
    options.setTimeframe(workspace.timeframe);
    options.setChartType(workspace.chartType);
    setCryptoExchange(workspace.cryptoExchange);
    setTheme(workspace.theme);
    options.setIndicators((current) => applyIndicatorSelection(current, workspace.enabledIndicators));
    options.setMode("chart");
  }, [options.setChartType, options.setIndicators, options.setMode, options.setSymbol, options.setTimeframe, workspaces]);

  const deleteWorkspace = useCallback((id: string) => setWorkspaces((current) => current.filter((item) => item.id !== id)), []);

  return {
    cryptoExchange, setCryptoExchange, theme, locale, leftOpen, rightOpen, workspaces,
    compareOverlays, addCompare, updateCompare, removeCompare,
    saveWorkspace, applyWorkspace, deleteWorkspace,
    toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
    toggleLocale: () => setLocale((current) => current === "en" ? "ru" : "en"),
    toggleLeft: () => setLeftOpen((current) => !current),
    toggleRight: () => setRightOpen((current) => !current)
  };
}
