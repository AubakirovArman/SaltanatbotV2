import { Activity, Crosshair, GitCompareArrows, Link2, Link2Off, MoveHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import type { CompareOverlayConfig, LinkedCrosshair, LinkedTimeRange } from "../chart/types";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import { useMarketStream, type MarketStreamState } from "../hooks/useMarketStream";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import type { CatalogResponse, DataExchange, Instrument } from "../types";
import type { ChartLayoutPreset, WorkspaceChart } from "../workspace/workspaces";
import { matchesShortcut } from "../app/shortcuts";
import { ChartCanvas } from "./ChartCanvas";
import { chartTypeLabel } from "./chartTypePresentation";
import { applyPaneIndicatorOverrides, capturePaneIndicatorOverrides } from "../chart/paneIndicators";
import { createCompareOverlay, MAX_COMPARE, normalizeCompareOverlays } from "../chart/compareConfig";
import { useCompareSeries, type CompareSeriesState } from "../hooks/useCompareSeries";

interface MultiChartWorkspaceProps {
  preset: ChartLayoutPreset;
  charts: WorkspaceChart[];
  primary: ReactNode;
  catalog?: CatalogResponse;
  exchange: DataExchange;
  locale: Locale;
  indicators: IndicatorConfig[];
  onIndicatorsChange: (indicators: IndicatorConfig[]) => void;
  onEditIndicatorLogic: (indicator: IndicatorConfig) => void;
  theme: string;
  linkedCrosshair?: LinkedCrosshair;
  onLinkedCrosshairChange: (crosshair?: LinkedCrosshair) => void;
  linkedTimeRange?: LinkedTimeRange;
  onLinkedTimeRangeChange: (range?: LinkedTimeRange) => void;
  onUpdateChart: (id: string, patch: Partial<WorkspaceChart>) => void;
  activeChartId?: string;
  onActiveChartChange: (id: string) => void;
  onMarketStreamChange: (id: string, stream?: PaneMarketStream) => void;
  compareOverlays: CompareOverlayConfig[];
  compareState: CompareSeriesState;
  maximizeShortcut: string;
  previousChartShortcut: string;
  nextChartShortcut: string;
}

export interface PaneMarketStream extends MarketStreamState {
  symbol: string;
  timeframe: WorkspaceChart["timeframe"];
}

const EMPTY_COMPARE_OVERLAYS: CompareOverlayConfig[] = [];

export function MultiChartWorkspace({ preset, charts, primary, catalog, exchange, locale, indicators, onIndicatorsChange, onEditIndicatorLogic, theme, linkedCrosshair, onLinkedCrosshairChange, linkedTimeRange, onLinkedTimeRangeChange, onUpdateChart, activeChartId, onActiveChartChange, onMarketStreamChange, compareOverlays, compareState, maximizeShortcut, previousChartShortcut, nextChartShortcut }: MultiChartWorkspaceProps) {
  const primaryChart = charts[0];
  const [maximizedChartId, setMaximizedChartId] = useState<string>();
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const canMaximize = charts.length > 1;
  const toggleMaximize = (id: string) => {
    onActiveChartChange(id);
    setMaximizedChartId((current) => current === id ? undefined : id);
  };
  const moveActiveChart = useCallback((offset: number) => {
    if (charts.length < 2) return;
    const currentIndex = Math.max(0, charts.findIndex(({ id }) => id === activeChartId));
    const next = charts[(currentIndex + offset + charts.length) % charts.length];
    onActiveChartChange(next.id);
    if (maximizedChartId) setMaximizedChartId(next.id);
    window.requestAnimationFrame(() => paneRefs.current.get(next.id)?.focus({ preventScroll: true }));
  }, [activeChartId, charts, maximizedChartId, onActiveChartChange]);

  useEffect(() => {
    const ids = new Set(charts.map((chart) => chart.id));
    if (maximizedChartId && !ids.has(maximizedChartId)) setMaximizedChartId(undefined);
  }, [charts, maximizedChartId]);

  useEffect(() => {
    if (!canMaximize && maximizedChartId) setMaximizedChartId(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("[aria-modal='true']")) return;
      const editing = event.target instanceof HTMLElement && event.target.matches("input, textarea, [contenteditable='true']");
      if (!editing && matchesShortcut(event, previousChartShortcut)) {
        event.preventDefault();
        moveActiveChart(-1);
        return;
      }
      if (!editing && matchesShortcut(event, nextChartShortcut)) {
        event.preventDefault();
        moveActiveChart(1);
        return;
      }
      if (event.key === "Escape" && maximizedChartId) {
        event.preventDefault();
        setMaximizedChartId(undefined);
        return;
      }
      if (!matchesShortcut(event, maximizeShortcut) || !canMaximize || !activeChartId) return;
      if (editing) return;
      event.preventDefault();
      toggleMaximize(activeChartId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChartId, canMaximize, maximizeShortcut, maximizedChartId, moveActiveChart, nextChartShortcut, previousChartShortcut]);

  const paneProps = (id: string) => ({
    className: `multi-chart-pane ${id === primaryChart?.id ? "primary" : "secondary"} ${activeChartId === id && canMaximize ? "active" : ""} ${maximizedChartId === id ? "maximized" : ""}`,
    "data-active": activeChartId === id ? "true" : "false",
    tabIndex: -1,
    ref: (node: HTMLElement | null) => {
      if (node) paneRefs.current.set(id, node);
      else paneRefs.current.delete(id);
    },
    onFocusCapture: () => onActiveChartChange(id),
    onPointerDownCapture: () => onActiveChartChange(id)
  });

  return (
    <div className={`multi-chart-grid ${preset} ${maximizedChartId ? "has-maximized" : ""}`} aria-label={shellText(locale, "multiChartWorkspace")}>
      {primaryChart && <section {...paneProps(primaryChart.id)} aria-label={`${shellText(locale, "primaryChart")} · ${primaryChart.symbol} ${primaryChart.timeframe}${activeChartId === primaryChart.id ? ` · ${shellText(locale, "activeChart")}` : ""}`}>
        {canMaximize && activeChartId === primaryChart.id && <PaneActiveIndicator locale={locale} paneNumber={1} />}
        {canMaximize && <PaneMaximizeButton locale={locale} symbol={primaryChart.symbol} shortcut={maximizeShortcut} maximized={maximizedChartId === primaryChart.id} floating onToggle={() => toggleMaximize(primaryChart.id)} />}
        {primary}
      </section>}
      {charts.slice(1).map((chart, index) => (
        <SecondaryChartPane
          key={chart.id}
          paneProps={paneProps(chart.id)}
          active={activeChartId === chart.id}
          chart={chart}
          paneNumber={index + 2}
          canMaximize={canMaximize}
          maximized={maximizedChartId === chart.id}
          maximizeShortcut={maximizeShortcut}
          onToggleMaximize={() => toggleMaximize(chart.id)}
          catalog={catalog}
          exchange={exchange}
          locale={locale}
          indicators={indicators}
          onIndicatorsChange={onIndicatorsChange}
          onEditIndicatorLogic={onEditIndicatorLogic}
          theme={theme}
          linkedCrosshair={linkedCrosshair}
          onLinkedCrosshairChange={onLinkedCrosshairChange}
          linkedTimeRange={linkedTimeRange}
          onLinkedTimeRangeChange={onLinkedTimeRangeChange}
          onUpdate={onUpdateChart}
          onMarketStreamChange={onMarketStreamChange}
          compareOverlays={compareOverlays}
          compareState={compareState}
        />
      ))}
    </div>
  );
}

function SecondaryChartPane({ chart, paneNumber, paneProps, active, canMaximize, maximized, maximizeShortcut, onToggleMaximize, catalog, exchange, locale, indicators, onIndicatorsChange, onEditIndicatorLogic, theme, linkedCrosshair, onLinkedCrosshairChange, linkedTimeRange, onLinkedTimeRangeChange, onUpdate, onMarketStreamChange, compareOverlays, compareState }: Omit<MultiChartWorkspaceProps, "preset" | "charts" | "primary" | "onUpdateChart" | "activeChartId" | "onActiveChartChange" | "previousChartShortcut" | "nextChartShortcut"> & { chart: WorkspaceChart; paneNumber: number; paneProps: ComponentPropsWithRef<"section">; active: boolean; canMaximize: boolean; maximized: boolean; onToggleMaximize: () => void; onUpdate: MultiChartWorkspaceProps["onUpdateChart"] }) {
  const stream = useMarketStream(chart.symbol, chart.timeframe, exchange);
  const instrument = catalog?.instruments.find((item) => item.symbol === chart.symbol) ?? fallbackInstrument(chart.symbol);
  const paneIndicators = chart.linkIndicators ? indicators : applyPaneIndicatorOverrides(indicators, chart.indicatorOverrides);
  const paneCompareOverlays = useMemo(() => (chart.linkCompare ? compareOverlays : chart.compareOverlays ?? []).filter((overlay) => overlay.symbol !== chart.symbol), [chart.compareOverlays, chart.linkCompare, chart.symbol, compareOverlays]);
  const localCompareState = useCompareSeries(chart.linkCompare ? EMPTY_COMPARE_OVERLAYS : paneCompareOverlays, exchange);
  const paneCompareState = chart.linkCompare ? compareState : localCompareState;
  const compareCandidates = useMemo(() => (catalog?.instruments ?? []).filter((item) => item.symbol !== chart.symbol).map((item) => ({ symbol: item.symbol, displayName: item.displayName })), [catalog, chart.symbol]);
  const commitCompare = (next: CompareOverlayConfig[]) => onUpdate(chart.id, { linkCompare: false, compareOverlays: normalizeCompareOverlays(next, chart.timeframe, chart.chartType) });
  const addCompare = (symbol: string) => {
    if (paneCompareOverlays.length >= MAX_COMPARE || paneCompareOverlays.some((overlay) => overlay.symbol === symbol)) return;
    commitCompare([...paneCompareOverlays, createCompareOverlay(symbol, paneCompareOverlays.length, chart.timeframe, chart.chartType)]);
  };
  const updateCompare = (id: string, patch: Partial<CompareOverlayConfig>) => commitCompare(paneCompareOverlays.map((overlay) => overlay.id === id ? { ...overlay, ...patch } : overlay));
  const removeCompare = (id: string) => commitCompare(paneCompareOverlays.filter((overlay) => overlay.id !== id));
  useEffect(() => {
    onMarketStreamChange(chart.id, active ? { ...stream, symbol: chart.symbol, timeframe: chart.timeframe } : undefined);
  }, [active, chart.id, chart.symbol, chart.timeframe, onMarketStreamChange, stream]);
  useEffect(() => () => onMarketStreamChange(chart.id), [chart.id, onMarketStreamChange]);
  const linkButton = (field: "linkSymbol" | "linkTimeframe" | "linkCrosshair" | "linkTimeRange" | "linkIndicators" | "linkCompare", linkLabel: string, unlinkLabel: string, ActiveIcon = Link2) => {
    const linked = chart[field];
    const Icon = linked ? ActiveIcon : Link2Off;
    const label = linked ? unlinkLabel : linkLabel;
    return (
      <button type="button" data-link-field={field} className={linked ? "active" : ""} aria-pressed={linked} aria-label={label} title={label} onClick={() => onUpdate(chart.id,
        field === "linkIndicators" && linked ? { linkIndicators: false, indicatorOverrides: capturePaneIndicatorOverrides(paneIndicators) }
          : field === "linkCompare" && linked ? { linkCompare: false, compareOverlays: paneCompareOverlays.map((overlay) => ({ ...overlay })) }
            : { [field]: !linked })}>
        <Icon size={12} aria-hidden="true" />
      </button>
    );
  };
  return (
    <section {...paneProps} aria-label={`${chart.symbol} ${chart.timeframe}${active ? ` · ${shellText(locale, "activeChart")}` : ""}`}>
      {active && <PaneActiveIndicator locale={locale} paneNumber={paneNumber} />}
      <div className="chart-pane-controls">
        <span className="pane-number" aria-hidden="true">{paneNumber}</span>
        <label>
          <span className="sr-only">{shellText(locale, "symbol")}</span>
          <select aria-label={`${shellText(locale, "symbol")} · ${paneNumber}`} value={chart.symbol} onChange={(event) => onUpdate(chart.id, { symbol: event.target.value, linkSymbol: false })}>
            {(catalog?.instruments ?? [instrument]).map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
          </select>
        </label>
        {linkButton("linkSymbol", shellText(locale, "linkSymbol"), shellText(locale, "unlinkSymbol"))}
        <label>
          <span className="sr-only">{shellText(locale, "timeframe")}</span>
          <select aria-label={`${shellText(locale, "timeframe")} · ${paneNumber}`} value={chart.timeframe} onChange={(event) => onUpdate(chart.id, { timeframe: event.target.value as WorkspaceChart["timeframe"], linkTimeframe: false })}>
            {(catalog?.timeframes ?? [chart.timeframe]).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {linkButton("linkTimeframe", shellText(locale, "linkTimeframe"), shellText(locale, "unlinkTimeframe"))}
        <label>
          <span className="sr-only">{shellText(locale, "chartType")}</span>
          <select aria-label={`${shellText(locale, "chartType")} · ${paneNumber}`} value={chart.chartType} onChange={(event) => onUpdate(chart.id, { chartType: event.target.value as WorkspaceChart["chartType"] })}>
            {(catalog?.chartTypes ?? [chart.chartType]).map((item) => <option key={item} value={item}>{chartTypeLabel(locale, item)}</option>)}
          </select>
        </label>
        {linkButton("linkIndicators", shellText(locale, "linkIndicators"), shellText(locale, "unlinkIndicators"), Activity)}
        {linkButton("linkCompare", shellText(locale, "linkCompare"), shellText(locale, "unlinkCompare"), GitCompareArrows)}
        {linkButton("linkCrosshair", shellText(locale, "linkCrosshair"), shellText(locale, "unlinkCrosshair"), Crosshair)}
        {linkButton("linkTimeRange", shellText(locale, "linkTimeRange"), shellText(locale, "unlinkTimeRange"), MoveHorizontal)}
        {canMaximize && <PaneMaximizeButton locale={locale} symbol={chart.symbol} shortcut={maximizeShortcut} maximized={maximized} onToggle={onToggleMaximize} />}
        <span className={`pane-feed ${stream.connection}`} role="status">{stream.provider} · {stream.latencyMs ?? "—"} ms</span>
      </div>
      <ChartCanvas
        compactChrome={!maximized}
        showIndicatorControls={maximized}
        candles={stream.candles}
        chartType={chart.chartType}
        instrument={instrument}
        timeframe={chart.timeframe}
        locale={locale}
        dataExchange={exchange}
        indicators={paneIndicators}
        onIndicatorsChange={(next) => onUpdate(chart.id, { linkIndicators: false, indicatorOverrides: capturePaneIndicatorOverrides(next) })}
        onEditIndicatorLogic={onEditIndicatorLogic}
        theme={theme}
        onNeedHistory={stream.loadOlder}
        chartId={chart.id}
        linkedCrosshair={chart.linkCrosshair ? linkedCrosshair : undefined}
        onLinkedCrosshairChange={chart.linkCrosshair ? onLinkedCrosshairChange : undefined}
        linkedTimeRange={chart.linkTimeRange ? linkedTimeRange : undefined}
        onLinkedTimeRangeChange={chart.linkTimeRange ? onLinkedTimeRangeChange : undefined}
        compareSeries={paneCompareState.series}
        compareLoading={paneCompareState.loading}
        compareErrors={paneCompareState.errors}
        compareOverlays={paneCompareOverlays}
        compareCandidates={compareCandidates}
        compareTimeframes={catalog?.timeframes ?? []}
        compareChartTypes={catalog?.chartTypes ?? []}
        onAddCompare={maximized ? addCompare : undefined}
        onUpdateCompare={maximized ? updateCompare : undefined}
        onRemoveCompare={maximized ? removeCompare : undefined}
      />
    </section>
  );
}

function PaneActiveIndicator({ locale, paneNumber }: { locale: Locale; paneNumber: number }) {
  return <span className="pane-active-indicator" aria-hidden="true"><span>●</span>{shellText(locale, "activeChart")} · {paneNumber}</span>;
}

function PaneMaximizeButton({ locale, symbol, shortcut, maximized, floating = false, onToggle }: { locale: Locale; symbol: string; shortcut: string; maximized: boolean; floating?: boolean; onToggle: () => void }) {
  const label = maximized ? shellText(locale, "restoreChartGrid") : `${shellText(locale, "maximizeChart")} ${symbol}`;
  return (
    <button type="button" className={`pane-maximize ${floating ? "floating" : ""}`} aria-label={label} aria-pressed={maximized} title={`${label} · ${shortcut}`} onClick={onToggle}>
      <span className="pane-maximize-glyph" aria-hidden="true">⤢</span>
    </button>
  );
}

function fallbackInstrument(symbol: string): Instrument {
  return { symbol, displayName: symbol, assetClass: "crypto", exchange: "Unknown", currency: "USDT", provider: "binance", basePrice: 1, decimals: 2 };
}
