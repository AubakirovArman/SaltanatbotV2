import { Crosshair, Link2, Link2Off, MoveHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import type { LinkedCrosshair, LinkedTimeRange } from "../chart/types";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import { useMarketStream } from "../hooks/useMarketStream";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import type { CatalogResponse, DataExchange, Instrument } from "../types";
import type { ChartLayoutPreset, WorkspaceChart } from "../workspace/workspaces";
import { ChartCanvas } from "./ChartCanvas";
import { chartTypeLabel } from "./chartTypePresentation";

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
}

export function MultiChartWorkspace({ preset, charts, primary, catalog, exchange, locale, indicators, onIndicatorsChange, onEditIndicatorLogic, theme, linkedCrosshair, onLinkedCrosshairChange, linkedTimeRange, onLinkedTimeRangeChange, onUpdateChart }: MultiChartWorkspaceProps) {
  return (
    <div className={`multi-chart-grid ${preset}`} aria-label={shellText(locale, "multiChartWorkspace")}>
      <section className="multi-chart-pane primary" aria-label={shellText(locale, "primaryChart")}>{primary}</section>
      {charts.slice(1).map((chart, index) => (
        <SecondaryChartPane
          key={chart.id}
          chart={chart}
          paneNumber={index + 2}
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
        />
      ))}
    </div>
  );
}

function SecondaryChartPane({ chart, paneNumber, catalog, exchange, locale, indicators, onIndicatorsChange, onEditIndicatorLogic, theme, linkedCrosshair, onLinkedCrosshairChange, linkedTimeRange, onLinkedTimeRangeChange, onUpdate }: Omit<MultiChartWorkspaceProps, "preset" | "charts" | "primary" | "onUpdateChart"> & { chart: WorkspaceChart; paneNumber: number; onUpdate: MultiChartWorkspaceProps["onUpdateChart"] }) {
  const stream = useMarketStream(chart.symbol, chart.timeframe, exchange);
  const instrument = catalog?.instruments.find((item) => item.symbol === chart.symbol) ?? fallbackInstrument(chart.symbol);
  const linkButton = (field: "linkSymbol" | "linkTimeframe" | "linkCrosshair" | "linkTimeRange", linkLabel: string, unlinkLabel: string, ActiveIcon = Link2) => {
    const linked = chart[field];
    const Icon = linked ? ActiveIcon : Link2Off;
    const label = linked ? unlinkLabel : linkLabel;
    return (
      <button type="button" data-link-field={field} className={linked ? "active" : ""} aria-pressed={linked} aria-label={label} title={label} onClick={() => onUpdate(chart.id, { [field]: !linked })}>
        <Icon size={12} aria-hidden="true" />
      </button>
    );
  };
  return (
    <section className="multi-chart-pane secondary" aria-label={`${chart.symbol} ${chart.timeframe}`}>
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
        {linkButton("linkCrosshair", shellText(locale, "linkCrosshair"), shellText(locale, "unlinkCrosshair"), Crosshair)}
        {linkButton("linkTimeRange", shellText(locale, "linkTimeRange"), shellText(locale, "unlinkTimeRange"), MoveHorizontal)}
        <span className={`pane-feed ${stream.connection}`} role="status">{stream.provider} · {stream.latencyMs ?? "—"} ms</span>
      </div>
      <ChartCanvas
        candles={stream.candles}
        chartType={chart.chartType}
        instrument={instrument}
        timeframe={chart.timeframe}
        locale={locale}
        dataExchange={exchange}
        indicators={indicators}
        onIndicatorsChange={onIndicatorsChange}
        onEditIndicatorLogic={onEditIndicatorLogic}
        theme={theme}
        onNeedHistory={stream.loadOlder}
        chartId={chart.id}
        linkedCrosshair={chart.linkCrosshair ? linkedCrosshair : undefined}
        onLinkedCrosshairChange={chart.linkCrosshair ? onLinkedCrosshairChange : undefined}
        linkedTimeRange={chart.linkTimeRange ? linkedTimeRange : undefined}
        onLinkedTimeRangeChange={chart.linkTimeRange ? onLinkedTimeRangeChange : undefined}
      />
    </section>
  );
}

function fallbackInstrument(symbol: string): Instrument {
  return { symbol, displayName: symbol, assetClass: "crypto", exchange: "Unknown", currency: "USDT", provider: "binance", basePrice: 1, decimals: 2 };
}
