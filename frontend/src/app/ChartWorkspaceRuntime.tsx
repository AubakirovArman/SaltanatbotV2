import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useChartArtifactOverlay } from "../chart/useChartArtifactOverlay";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { LinkedCrosshair, LinkedTimeRange } from "../chart/types";
import { ChartCanvas } from "../components/ChartCanvas";
import { MobilePanelDialog } from "../components/MobilePanelDialog";
import { MultiChartWorkspace, type PaneMarketStream } from "../components/MultiChartWorkspace";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { StatsPanel } from "../components/StatsPanel";
import { WatchlistQuotePanel } from "../components/WatchlistQuotePanel";
import { useCompareSeries } from "../hooks/useCompareSeries";
import { useLivePositions } from "../hooks/useLivePositions";
import { useMarketStream, type ConnectionState } from "../hooks/useMarketStream";
import { usePriceAlerts } from "../hooks/usePriceAlerts";
import { localized, type Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { useArtifactLibrary } from "../strategy/useArtifactLibrary";
import type { AssetClass, Candle, CatalogResponse, ChartType, Instrument, Timeframe } from "../types";
import { useAppShell } from "./useAppShell";
import { recordBrowserRender } from "../performance/browserProbe";

type AppShellState = ReturnType<typeof useAppShell>;
type ArtifactLibraryState = ReturnType<typeof useArtifactLibrary>;
type ArtifactOverlayState = ReturnType<typeof useChartArtifactOverlay>;
type PriceAlertsState = ReturnType<typeof usePriceAlerts>;

interface ChartWorkspaceRuntimeProps {
  catalog?: CatalogResponse;
  loading: boolean;
  error?: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  asset: AssetClass | "all";
  setAsset: Dispatch<SetStateAction<AssetClass | "all">>;
  indicators: IndicatorConfig[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  shell: AppShellState;
  isMobile: boolean;
  mobilePanel?: "markets" | "instrument";
  setMobilePanel: Dispatch<SetStateAction<"markets" | "instrument" | undefined>>;
  locale: Locale;
  theme: "dark" | "light";
  primaryInstrument: Instrument;
  activeInstrument: Instrument;
  artifactLibrary: ArtifactLibraryState;
  artifactOverlay: ArtifactOverlayState;
  priceAlerts: PriceAlertsState;
  storageOwnerId?: string;
  primaryCandlesRef: MutableRefObject<Candle[]>;
  onConnectionChange: (connection: ConnectionState) => void;
  linkedCrosshair?: LinkedCrosshair;
  onLinkedCrosshairChange: Dispatch<SetStateAction<LinkedCrosshair | undefined>>;
  linkedTimeRange?: LinkedTimeRange;
  onLinkedTimeRangeChange: Dispatch<SetStateAction<LinkedTimeRange | undefined>>;
  maximizeShortcut: string;
  previousChartShortcut: string;
  nextChartShortcut: string;
}

/**
 * Owns every high-frequency chart resource.
 *
 * The component is mounted only in Monitoring mode, so candle/quote ticks cannot
 * rerender Strategy Studio, Trading, Screener or the application shell. It also
 * scopes watchlist quotes to the actually visible markets panel.
 */
export function ChartWorkspaceRuntime({
  catalog,
  loading,
  error,
  symbol,
  timeframe,
  chartType,
  asset,
  setAsset,
  indicators,
  setIndicators,
  shell,
  isMobile,
  mobilePanel,
  setMobilePanel,
  locale,
  theme,
  primaryInstrument,
  activeInstrument,
  artifactLibrary,
  artifactOverlay,
  priceAlerts,
  storageOwnerId,
  primaryCandlesRef,
  onConnectionChange,
  linkedCrosshair,
  onLinkedCrosshairChange,
  linkedTimeRange,
  onLinkedTimeRangeChange,
  maximizeShortcut,
  previousChartShortcut,
  nextChartShortcut
}: ChartWorkspaceRuntimeProps) {
  recordBrowserRender("ChartWorkspaceRuntime");
  const {
    cryptoExchange,
    leftOpen,
    rightOpen,
    leftSize,
    rightSize,
    panelsSwapped,
    compareOverlays
  } = shell;
  const [paneStreams, setPaneStreams] = useState<Record<string, PaneMarketStream>>({});
  const [primaryOperational, setPrimaryOperational] = useState(true);
  const primaryChart = shell.charts[0];
  const primaryExchange = primaryChart?.exchange ?? cryptoExchange;
  const primaryMarketType = primaryChart?.marketType ?? "spot";
  const primaryPriceType = primaryExchange === "bybit" ? "last" : (primaryChart?.priceType ?? "last");
  const stream = useMarketStream(symbol, timeframe, primaryExchange, {
    marketType: primaryMarketType,
    priceType: primaryPriceType,
    enabled: primaryOperational
  });
  primaryCandlesRef.current = stream.candles;

  const activeChart = shell.activeChart ?? primaryChart;
  const activeExchange = activeChart?.exchange ?? cryptoExchange;
  const activeMarketType = activeChart?.marketType ?? "spot";
  const activePriceType = activeExchange === "bybit" ? "last" : (activeChart?.priceType ?? "last");
  const activeIsPrimary = activeChart?.id === primaryChart?.id;
  const secondaryStream = paneStreams[activeChart?.id ?? ""];
  const activeStream = activeIsPrimary
    ? stream
    : secondaryStream?.symbol === activeChart?.symbol
        && secondaryStream.timeframe === activeChart?.timeframe
        && secondaryStream.exchange === activeExchange
        && secondaryStream.marketType === activeMarketType
        && secondaryStream.priceType === activePriceType
      ? secondaryStream
      : undefined;
  const activeCandles = activeStream?.candles ?? [];

  useEffect(() => {
    onConnectionChange(activeStream?.connection ?? "connecting");
  }, [activeStream?.connection, onConnectionChange]);

  const updatePaneStream = useCallback((id: string, next?: PaneMarketStream) => {
    setPaneStreams((current) => {
      if (next) return current[id] === next ? current : { ...current, [id]: next };
      if (!(id in current)) return current;
      const copy = { ...current };
      delete copy[id];
      return copy;
    });
  }, []);

  const compareState = useCompareSeries(compareOverlays, primaryExchange);
  const allInstruments = useMemo(() => catalog?.instruments ?? [primaryInstrument], [catalog, primaryInstrument]);
  const instruments = useMemo(() => {
    return asset === "all" ? allInstruments : allInstruments.filter((item) => item.assetClass === asset);
  }, [allInstruments, asset]);
  const watchlistVisible = isMobile ? mobilePanel === "markets" : leftOpen;
  const compareCandidates = useMemo(
    () => (catalog?.instruments ?? []).filter((item) => item.symbol !== symbol).map((item) => ({ symbol: item.symbol, displayName: item.displayName })),
    [catalog, symbol]
  );
  const livePositions = useLivePositions(primaryInstrument.symbol, { enabled: primaryOperational });

  const setActiveSymbol = useCallback((nextSymbol: string) => shell.updateActiveChart({ symbol: nextSymbol }), [shell.updateActiveChart]);
  const watchlistPanel = (
    <WatchlistQuotePanel
      enabled={watchlistVisible}
      locale={locale}
      instruments={instruments}
      quoteInstruments={allInstruments}
      selectedSymbol={activeChart?.symbol ?? symbol}
      selectedAsset={asset}
      latest={activeCandles.at(-1)}
      timeframe={activeChart?.timeframe ?? timeframe}
      exchange={activeExchange}
      marketType={activeMarketType}
      priceType={activePriceType}
      onSelectSymbol={(nextSymbol) => {
        setActiveSymbol(nextSymbol);
        if (isMobile) setMobilePanel(undefined);
      }}
      onSelectAsset={setAsset}
      onSelectExchange={(nextExchange) => {
        shell.setCryptoExchange(nextExchange);
        shell.updateActiveChart({ exchange: nextExchange, priceType: "last" });
      }}
      storageOwnerId={storageOwnerId}
    />
  );
  const statsPanel = (
    <StatsPanel
      locale={locale}
      instrument={activeInstrument}
      candles={activeCandles}
      provider={activeStream?.provider ?? "Loading"}
      connection={activeStream?.connection ?? "connecting"}
      message={activeStream?.message ?? `Loading ${activeChart?.symbol ?? symbol} ${activeChart?.timeframe ?? timeframe}`}
      latencyMs={activeStream?.latencyMs}
      gapCount={activeStream?.gapCount}
      missingBars={activeStream?.missingBars}
      fallbackActive={activeStream?.fallbackActive}
      exchange={activeExchange}
      marketType={activeMarketType}
      priceType={activePriceType}
      alerts={priceAlerts.alerts}
      onAddAlert={priceAlerts.addAlert}
      onRemoveAlert={priceAlerts.removeAlert}
      onResetAlert={priceAlerts.resetAlert}
    />
  );

  const actualLeftOpen = panelsSwapped ? rightOpen : leftOpen;
  const actualRightOpen = panelsSwapped ? leftOpen : rightOpen;

  return (
    <>
      {!isMobile && (actualLeftOpen ? panelsSwapped ? statsPanel : watchlistPanel : <span aria-hidden="true" />)}

      {isMobile && (
        <>
          <MobilePanelDialog
            id="markets-panel"
            open={mobilePanel === "markets"}
            label={shellText(locale, "markets")}
            closeLabel={localized(locale, { en: "Close markets", ru: "Закрыть рынки", kk: "Нарықтарды жабу" })}
            initialFocus=".market-search input"
            onClose={() => setMobilePanel(undefined)}
          >
            {watchlistPanel}
          </MobilePanelDialog>
          <MobilePanelDialog
            id="instrument-panel"
            open={mobilePanel === "instrument"}
            label={shellText(locale, "currentInstrument")}
            closeLabel={localized(locale, { en: "Close instrument details", ru: "Закрыть данные инструмента", kk: "Құрал деректерін жабу" })}
            onClose={() => setMobilePanel(undefined)}
          >
            {statsPanel}
          </MobilePanelDialog>
        </>
      )}

      <section className="chart-panel">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {loading && (
          <div className="loading-banner" role="status" aria-live="polite">
            {shellText(locale, "loadingCatalog")}
          </div>
        )}
        <MultiChartWorkspace
          preset={shell.layoutPreset}
          charts={shell.charts}
          catalog={catalog}
          exchange={cryptoExchange}
          locale={locale}
          indicators={indicators}
          onIndicatorsChange={setIndicators}
          onEditIndicatorLogic={artifactLibrary.selectIndicatorLogic}
          theme={theme}
          linkedCrosshair={linkedCrosshair}
          onLinkedCrosshairChange={onLinkedCrosshairChange}
          linkedTimeRange={linkedTimeRange}
          onLinkedTimeRangeChange={onLinkedTimeRangeChange}
          onUpdateChart={shell.updateChart}
          activeChartId={shell.activeChartId}
          onActiveChartChange={shell.setActiveChartId}
          onMarketStreamChange={updatePaneStream}
          onPrimaryOperationalChange={setPrimaryOperational}
          compareOverlays={compareOverlays}
          compareState={compareState}
          maximizeShortcut={maximizeShortcut}
          previousChartShortcut={previousChartShortcut}
          nextChartShortcut={nextChartShortcut}
          storageOwnerId={storageOwnerId}
          primary={
            <ChartCanvas
              operational={primaryOperational}
              compactChrome={shell.layoutPreset !== "single"}
              candles={stream.candles}
              chartType={chartType}
              instrument={primaryInstrument}
              timeframe={timeframe}
              locale={locale}
              timeZone={primaryChart?.timeZone}
              onTimeZoneChange={(timeZone) => shell.updateChart(primaryChart?.id ?? "chart-1", { timeZone })}
              dataExchange={primaryExchange}
              dataMarketType={primaryMarketType}
              dataPriceType={primaryPriceType}
              indicators={indicators}
              onIndicatorsChange={setIndicators}
              onEditIndicatorLogic={artifactLibrary.selectIndicatorLogic}
              signals={artifactOverlay.activeOverlay?.signals}
              trades={artifactOverlay.activeOverlay?.trades}
              plots={artifactOverlay.activeOverlay?.plots}
              shapes={artifactOverlay.activeOverlay?.shapes}
              tables={artifactOverlay.activeOverlay?.tables}
              alerts={priceAlerts.alerts}
              onAddAlert={(price) =>
                priceAlerts.addAlert({
                  symbol: primaryInstrument.symbol,
                  price,
                  direction: price >= (stream.candles.at(-1)?.close ?? price) ? "above" : "below",
                  exchange: primaryExchange,
                  marketType: primaryMarketType,
                  priceType: primaryPriceType
                })
              }
              livePositions={livePositions}
              strategyName={artifactOverlay.activeOverlay?.name}
              strategySummary={artifactOverlay.activeOverlay?.summary}
              strategyInputs={artifactOverlay.activeOverlay?.inputs}
              onStrategyInputChange={artifactOverlay.updateInput}
              onClearStrategy={artifactOverlay.clear}
              customIndicators={artifactLibrary.customIndicators}
              strategies={artifactLibrary.strategies}
              activeArtifactId={artifactOverlay.activeOverlay?.id}
              onAddArtifact={artifactOverlay.addArtifact}
              focusTime={artifactOverlay.activeOverlay ? artifactOverlay.focusTime : undefined}
              theme={theme}
              onNeedHistory={stream.loadOlder}
              compareSeries={compareState.series}
              compareLoading={compareState.loading}
              compareErrors={compareState.errors}
              compareOverlays={compareOverlays}
              compareCandidates={compareCandidates}
              compareTimeframes={catalog?.timeframes ?? []}
              compareChartTypes={catalog?.chartTypes ?? []}
              onAddCompare={shell.addCompare}
              onUpdateCompare={shell.updateCompare}
              onRemoveCompare={shell.removeCompare}
              chartId={primaryChart?.id}
              storageOwnerId={storageOwnerId}
              linkedCrosshair={linkedCrosshair}
              onLinkedCrosshairChange={onLinkedCrosshairChange}
              linkedTimeRange={linkedTimeRange}
              onLinkedTimeRangeChange={onLinkedTimeRangeChange}
            />
          }
        />
      </section>

      {!isMobile && (actualRightOpen ? panelsSwapped ? watchlistPanel : statsPanel : <span aria-hidden="true" />)}
      {!isMobile && actualLeftOpen && <PanelResizeHandle side="left" value={leftSize} min={180} max={520} label={shellText(locale, "resizeMarketsPanel")} onResize={shell.setLeftSize} />}
      {!isMobile && actualRightOpen && <PanelResizeHandle side="right" value={rightSize} min={220} max={520} label={shellText(locale, "resizeInstrumentPanel")} onResize={shell.setRightSize} />}
    </>
  );
}
