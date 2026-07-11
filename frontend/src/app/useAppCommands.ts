import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { Command } from "../components/CommandPalette";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import { warmTradingView } from "../trading/loadTradingView";
import type { CatalogResponse, ChartType, Timeframe } from "../types";
import type { PriceAlert } from "../market/alerts";
import type { AppMode } from "./useAppShell";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { loadShortcuts, matchesShortcut, saveShortcuts, type ShortcutAction, type ShortcutMap } from "./shortcuts";

interface UseAppCommandsOptions {
  locale?: Locale;
  catalog?: CatalogResponse;
  indicators: IndicatorConfig[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  setSymbol: Dispatch<SetStateAction<string>>;
  setTimeframe: Dispatch<SetStateAction<Timeframe>>;
  setChartType: Dispatch<SetStateAction<ChartType>>;
  setMode: Dispatch<SetStateAction<AppMode>>;
  toggleTheme(): void;
  toggleLeft(): void;
  toggleRight(): void;
  alerts: PriceAlert[];
  removeAlert(id: string): void;
}

export function useAppCommands(options: UseAppCommandsOptions) {
  const locale = options.locale ?? "en";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(loadShortcuts);
  useEffect(() => saveShortcuts(shortcuts), [shortcuts]);
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const item of options.catalog?.instruments ?? []) list.push({
      id: `sym-${item.symbol}`,
      group: shellText(locale, "symbol"),
      label: `${item.symbol} · ${item.displayName}`,
      hint: item.exchange,
      run: () => { options.setSymbol(item.symbol); options.setMode("chart"); }
    });
    (options.catalog?.timeframes ?? []).forEach((timeframe, index) => list.push({
      id: `tf-${timeframe}`, group: shellText(locale, "timeframe"), label: timeframe, hint: `${shellText(locale, "key")} ${index + 1}`, run: () => options.setTimeframe(timeframe)
    }));
    for (const chartType of options.catalog?.chartTypes ?? []) list.push({
      id: `ct-${chartType}`, group: shellText(locale, "chartType"), label: chartType, run: () => { options.setChartType(chartType); options.setMode("chart"); }
    });
    list.push({ id: "view-chart", group: shellText(locale, "view"), label: shellText(locale, "openChart"), run: () => options.setMode("chart") });
    list.push({ id: "view-strategy", group: shellText(locale, "view"), label: shellText(locale, "openStrategy"), run: () => { warmStrategyLab(); options.setMode("strategy"); } });
    list.push({ id: "view-trade", group: shellText(locale, "view"), label: shellText(locale, "openTrading"), run: () => { warmTradingView(); options.setMode("trade"); } });
    list.push({ id: "theme", group: shellText(locale, "view"), label: shellText(locale, "toggleTheme"), run: options.toggleTheme });
    list.push({ id: "keyboard-shortcuts", group: shellText(locale, "view"), label: shellText(locale, "keyboardShortcuts"), hint: shortcuts.shortcutSettings, run: () => setShortcutSettingsOpen(true) });
    for (const indicator of options.indicators) list.push({
      id: `ind-${indicator.id}`,
      group: shellText(locale, "indicator"),
      label: `${shellText(locale, indicator.enabled ? "hide" : "show")} ${indicator.label}`,
      run: () => {
        options.setIndicators((current) => current.map((item) => item.id === indicator.id ? { ...item, enabled: !item.enabled } : item));
        options.setMode("chart");
      }
    });
    if (options.alerts.length) list.push({
      id: "alerts-clear",
      group: shellText(locale, "alerts"),
      label: `${shellText(locale, "clearAlerts")} (${options.alerts.length})`,
      run: () => options.alerts.forEach((alert) => options.removeAlert(alert.id))
    });
    return list;
  }, [options, shortcuts.shortcutSettings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (matchesShortcut(event, shortcuts.commandPalette)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (matchesShortcut(event, shortcuts.shortcutSettings)) {
        event.preventDefault();
        setShortcutSettingsOpen(true);
        return;
      }
      if (typing) return;
      const timeframeActions: ShortcutAction[] = ["timeframe1", "timeframe2", "timeframe3", "timeframe4", "timeframe5", "timeframe6"];
      const index = timeframeActions.findIndex((action) => matchesShortcut(event, shortcuts[action]));
      const timeframe = index >= 0 ? options.catalog?.timeframes[index] : undefined;
      if (timeframe) { event.preventDefault(); options.setTimeframe(timeframe); return; }
      const action = (shortcut: ShortcutAction, run: () => void) => {
        if (!matchesShortcut(event, shortcuts[shortcut])) return false;
        event.preventDefault();
        run();
        return true;
      };
      if (action("openChart", () => options.setMode("chart"))) return;
      if (action("openStrategy", () => { warmStrategyLab(); options.setMode("strategy"); })) return;
      if (action("openTrading", () => { warmTradingView(); options.setMode("trade"); })) return;
      if (action("toggleMarkets", options.toggleLeft)) return;
      action("toggleInstrument", options.toggleRight);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options.catalog, options.setMode, options.setTimeframe, options.toggleLeft, options.toggleRight, shortcuts]);

  return {
    paletteOpen, commands, openPalette: () => setPaletteOpen(true), closePalette: () => setPaletteOpen(false),
    shortcutSettingsOpen, openShortcutSettings: () => setShortcutSettingsOpen(true), closeShortcutSettings: () => setShortcutSettingsOpen(false),
    shortcuts, setShortcuts
  };
}
