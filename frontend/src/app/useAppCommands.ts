import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { Command } from "../components/CommandPalette";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import { warmTradingView } from "../trading/loadTradingView";
import type { CatalogResponse, ChartType, Timeframe } from "../types";
import type { PriceAlert } from "../market/alerts";
import type { AppMode } from "./useAppShell";

interface UseAppCommandsOptions {
  catalog?: CatalogResponse;
  indicators: IndicatorConfig[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  setSymbol: Dispatch<SetStateAction<string>>;
  setTimeframe: Dispatch<SetStateAction<Timeframe>>;
  setChartType: Dispatch<SetStateAction<ChartType>>;
  setMode: Dispatch<SetStateAction<AppMode>>;
  toggleTheme(): void;
  alerts: PriceAlert[];
  removeAlert(id: string): void;
}

export function useAppCommands(options: UseAppCommandsOptions) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const item of options.catalog?.instruments ?? []) list.push({
      id: `sym-${item.symbol}`,
      group: "Symbol",
      label: `${item.symbol} · ${item.displayName}`,
      hint: item.exchange,
      run: () => { options.setSymbol(item.symbol); options.setMode("chart"); }
    });
    (options.catalog?.timeframes ?? []).forEach((timeframe, index) => list.push({
      id: `tf-${timeframe}`, group: "Timeframe", label: timeframe, hint: `key ${index + 1}`, run: () => options.setTimeframe(timeframe)
    }));
    for (const chartType of options.catalog?.chartTypes ?? []) list.push({
      id: `ct-${chartType}`, group: "Chart type", label: chartType, run: () => { options.setChartType(chartType); options.setMode("chart"); }
    });
    list.push({ id: "view-chart", group: "View", label: "Open Chart", run: () => options.setMode("chart") });
    list.push({ id: "view-strategy", group: "View", label: "Open Strategy Lab", run: () => { warmStrategyLab(); options.setMode("strategy"); } });
    list.push({ id: "view-trade", group: "View", label: "Open Trading", run: () => { warmTradingView(); options.setMode("trade"); } });
    list.push({ id: "theme", group: "View", label: "Toggle light / dark theme", run: options.toggleTheme });
    for (const indicator of options.indicators) list.push({
      id: `ind-${indicator.id}`,
      group: "Indicator",
      label: `${indicator.enabled ? "Hide" : "Show"} ${indicator.label}`,
      run: () => {
        options.setIndicators((current) => current.map((item) => item.id === indicator.id ? { ...item, enabled: !item.enabled } : item));
        options.setMode("chart");
      }
    });
    if (options.alerts.length) list.push({
      id: "alerts-clear",
      group: "Alerts",
      label: `Clear all price alerts (${options.alerts.length})`,
      run: () => options.alerts.forEach((alert) => options.removeAlert(alert.id))
    });
    return list;
  }, [options]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const index = ["1", "2", "3", "4", "5", "6"].indexOf(event.key);
      const timeframe = index >= 0 ? options.catalog?.timeframes[index] : undefined;
      if (timeframe) options.setTimeframe(timeframe);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options.catalog, options.setTimeframe]);

  return { paletteOpen, commands, openPalette: () => setPaletteOpen(true), closePalette: () => setPaletteOpen(false) };
}
