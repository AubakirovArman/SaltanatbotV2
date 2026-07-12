import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useChartArtifactOverlay } from "./chart/useChartArtifactOverlay";
import { AlertToasts } from "./components/AlertToasts";
import { ChartCanvas } from "./components/ChartCanvas";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import { TopBar } from "./components/TopBar";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import { MultiChartWorkspace, type PaneMarketStream } from "./components/MultiChartWorkspace";
import { MobilePanelDialog } from "./components/MobilePanelDialog";
import { ShortcutSettingsDialog } from "./components/ShortcutSettingsDialog";
import type { LinkedCrosshair, LinkedTimeRange } from "./chart/types";
import { Watchlist } from "./components/Watchlist";
import { useCatalog } from "./hooks/useCatalog";
import { useCompareSeries } from "./hooks/useCompareSeries";
import { useMarketStream } from "./hooks/useMarketStream";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useLivePositions } from "./hooks/useLivePositions";
import { usePriceAlerts } from "./hooks/usePriceAlerts";
import { useSparklines } from "./hooks/useSparklines";
import { loadStrategyLab, warmStrategyLab } from "./strategy/loadStrategyLab";
import { loadTradingView } from "./trading/loadTradingView";
import { loadInitialWorkspaceState } from "./strategy/storage";
import { useArtifactLibrary } from "./strategy/useArtifactLibrary";
import type { AssetClass, ChartType, Instrument, Timeframe } from "./types";
import { useAppShell, type AppMode } from "./app/useAppShell";
import { useAppCommands } from "./app/useAppCommands";
import { shellText } from "./i18n/shell";
import type { Locale } from "./i18n";
import { localized, translate } from "./i18n";
import { loadLastChartSession } from "./app/chartSession";
import { pickDistinctMarketSymbols } from "./app/distinctMarkets";

const StrategyLab = lazy(loadStrategyLab);
const TradingView = lazy(loadTradingView);
const initialWorkspaceState = loadInitialWorkspaceState();

const fallbackInstrument: Instrument = {
  symbol: "BTCUSDT",
  displayName: "Bitcoin / Tether",
  assetClass: "crypto",
  exchange: "Binance",
  currency: "USDT",
  provider: "binance",
  basePrice: 64000,
  decimals: 2
};

export default function App() {
  const [initialChartSession] = useState(() => loadLastChartSession({ symbol: "BTCUSDT", timeframe: "1m", chartType: "candles" }));
  const initialPrimaryChart = initialChartSession.charts[0];
  const { catalog, loading, error } = useCatalog();
  const [symbol, setSymbol] = useState(initialPrimaryChart.symbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(initialPrimaryChart.timeframe);
  const [chartType, setChartType] = useState<ChartType>(initialPrimaryChart.chartType);
  const [asset, setAsset] = useState<AssetClass | "all">("all");
  const [mode, setMode] = useState<AppMode>("chart");
  const [indicators, setIndicators] = useState(initialWorkspaceState.indicators);
  const [linkedCrosshair, setLinkedCrosshair] = useState<LinkedCrosshair>();
  const [linkedTimeRange, setLinkedTimeRange] = useState<LinkedTimeRange>();
  const [paneStreams, setPaneStreams] = useState<Record<string, PaneMarketStream>>({});
  const [mobilePanel, setMobilePanel] = useState<"markets" | "instrument">();
  const shell = useAppShell({
    symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType,
    setMode, indicators, setIndicators, initialChartSession
  });
  const { cryptoExchange, theme, locale, leftOpen, rightOpen, leftSize, rightSize, workspaces, activeWorkspaceId, compareOverlays } = shell;
  const isMobile = useMediaQuery("(max-width: 760px)");
  useEffect(() => {
    document.title = `${translate(locale, mode)} · SaltanatbotV2`;
  }, [locale, mode]);
  useEffect(() => {
    if (!isMobile || mode !== "chart") setMobilePanel(undefined);
  }, [isMobile, mode]);
  const openStrategyWorkspace = useCallback(() => setMode("strategy"), []);
  const artifactLibrary = useArtifactLibrary({
    initialArtifacts: initialWorkspaceState.strategyLibrary,
    setIndicators,
    openStrategyWorkspace
  });
  const strategyLibrary = artifactLibrary.artifacts;
  const activeArtifactId = artifactLibrary.activeArtifactId;
  const stream = useMarketStream(symbol, timeframe, cryptoExchange);
  const activeChart = shell.activeChart ?? shell.charts[0];
  const activeInstrument = catalog?.instruments.find((item) => item.symbol === activeChart?.symbol) ?? {
    ...fallbackInstrument,
    symbol: activeChart?.symbol ?? fallbackInstrument.symbol,
    displayName: activeChart?.symbol ?? fallbackInstrument.displayName
  };
  const setActiveSymbol = useCallback((nextSymbol: string) => shell.updateActiveChart({ symbol: nextSymbol }), [shell.updateActiveChart]);
  const setActiveTimeframe = useCallback((nextTimeframe: Timeframe) => shell.updateActiveChart({ timeframe: nextTimeframe }), [shell.updateActiveChart]);
  const setActiveChartType = useCallback((nextChartType: ChartType) => shell.updateActiveChart({ chartType: nextChartType }), [shell.updateActiveChart]);
  const updatePaneStream = useCallback((id: string, next?: PaneMarketStream) => {
    setPaneStreams((current) => {
      if (next) return current[id] === next ? current : { ...current, [id]: next };
      if (!(id in current)) return current;
      const copy = { ...current };
      delete copy[id];
      return copy;
    });
  }, []);
  const activeIsPrimary = activeChart?.id === shell.charts[0]?.id;
  const secondaryStream = paneStreams[activeChart?.id ?? ""];
  const activeStream = activeIsPrimary
    ? stream
    : secondaryStream?.symbol === activeChart?.symbol && secondaryStream.timeframe === activeChart?.timeframe
      ? secondaryStream
      : undefined;
  const activeCandles = activeStream?.candles ?? [];
  const compareState = useCompareSeries(compareOverlays, cryptoExchange);
  const showChart = useCallback((nextSymbol: string, nextTimeframe: Timeframe) => {
    setSymbol(nextSymbol);
    setTimeframe(nextTimeframe);
    setMode("chart");
  }, []);
  const artifactOverlay = useChartArtifactOverlay({
    artifacts: strategyLibrary,
    inputOverrides: artifactLibrary.inputOverrides,
    setInputOverrides: artifactLibrary.setInputOverrides,
    symbol,
    timeframe,
    candles: stream.candles,
    exchange: cryptoExchange,
    showChart
  });

  const instrument =
    catalog?.instruments.find((item) => item.symbol === symbol) ?? fallbackInstrument;

  const instruments = useMemo(() => {
    const list = catalog?.instruments ?? [fallbackInstrument];
    return asset === "all" ? list : list.filter((item) => item.assetClass === asset);
  }, [asset, catalog]);
  const distinctMarketSymbols = useMemo(() => pickDistinctMarketSymbols(symbol, catalog?.instruments ?? []), [catalog, symbol]);

  const allSymbols = useMemo(() => catalog?.instruments.map((item) => item.symbol) ?? [], [catalog]);
  const sparklines = useSparklines(allSymbols, activeChart?.timeframe ?? timeframe, cryptoExchange);

  // Compare picker candidates — every catalog symbol except the active base one.
  const compareCandidates = useMemo(
    () =>
      (catalog?.instruments ?? [])
        .filter((item) => item.symbol !== symbol)
        .map((item) => ({ symbol: item.symbol, displayName: item.displayName })),
    [catalog, symbol]
  );

  // Live price map for alert detection: the active symbol streams tick-by-tick, other
  // symbols fall back to the periodically-refreshed sparkline `last`.
  const latestClose = stream.candles.at(-1)?.close;
  const activeLatestClose = activeCandles.at(-1)?.close;
  const prices = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [sym, series] of Object.entries(sparklines)) {
      if (series?.last != null) map[sym] = series.last;
    }
    if (latestClose !== undefined) map[symbol] = latestClose;
    if (activeLatestClose !== undefined && activeChart) map[activeChart.symbol] = activeLatestClose;
    return map;
  }, [activeChart, activeLatestClose, sparklines, latestClose, symbol]);

  const decimalsFor = useCallback(
    (sym: string) => catalog?.instruments.find((item) => item.symbol === sym)?.decimals ?? 2,
    [catalog]
  );
  const priceAlerts = usePriceAlerts(prices, decimalsFor);
  const livePositions = useLivePositions(instrument.symbol);
  const appCommands = useAppCommands({
    locale,
    catalog,
    indicators,
    setIndicators,
    setSymbol: setActiveSymbol,
    setTimeframe: setActiveTimeframe,
    setChartType: setActiveChartType,
    setMode,
    toggleTheme: shell.toggleTheme,
    toggleLeft: shell.toggleLeft,
    toggleRight: shell.toggleRight,
    alerts: priceAlerts.alerts,
    removeAlert: priceAlerts.removeAlert
  });

  const chartCustomIndicators = artifactLibrary.customIndicators;
  const chartStrategies = artifactLibrary.strategies;
  const watchlistPanel = (
    <Watchlist
      locale={locale}
      instruments={instruments}
      selectedSymbol={activeChart?.symbol ?? symbol}
      selectedAsset={asset}
      latest={activeCandles.at(-1)}
      sparklines={sparklines}
      cryptoExchange={cryptoExchange}
      onSelectSymbol={(nextSymbol) => {
        setActiveSymbol(nextSymbol);
        if (isMobile) setMobilePanel(undefined);
      }}
      onSelectAsset={setAsset}
      onSelectExchange={shell.setCryptoExchange}
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
      alerts={priceAlerts.alerts}
      onAddAlert={priceAlerts.addAlert}
      onRemoveAlert={priceAlerts.removeAlert}
      onResetAlert={priceAlerts.resetAlert}
    />
  );
  const actualLeftOpen = shell.panelsSwapped ? rightOpen : leftOpen;
  const actualRightOpen = shell.panelsSwapped ? leftOpen : rightOpen;

  return (
    <div className="terminal-shell">
      <TopBar
        catalog={catalog}
        instrument={activeInstrument}
        timeframe={activeChart?.timeframe ?? timeframe}
        chartType={activeChart?.chartType ?? chartType}
        mode={mode}
        connection={activeStream?.connection ?? "connecting"}
        theme={theme}
        locale={locale}
        leftOpen={isMobile ? mobilePanel === "markets" : leftOpen}
        rightOpen={isMobile ? mobilePanel === "instrument" : rightOpen}
        mobilePanels={isMobile}
        panelsSwapped={shell.panelsSwapped}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        layoutPreset={shell.layoutPreset}
        onSaveWorkspace={shell.saveWorkspace}
        onApplyWorkspace={shell.applyWorkspace}
        onDeleteWorkspace={shell.deleteWorkspace}
        onExportWorkspace={shell.exportWorkspace}
        onImportWorkspace={shell.importWorkspace}
        onRollbackWorkspace={shell.rollbackWorkspaceVersion}
        onLayoutPresetChange={shell.setLayoutPreset}
        canUseDistinctMarkets={distinctMarketSymbols.length === 4}
        onDistinctMarkets={() => shell.setDistinctMarketLayout(distinctMarketSymbols)}
        onTimeframeChange={setActiveTimeframe}
        onChartTypeChange={setActiveChartType}
        onModeChange={setMode}
        onStrategyWarmup={warmStrategyLab}
        onOpenPalette={appCommands.openPalette}
        onOpenShortcutSettings={appCommands.openShortcutSettings}
        onToggleTheme={shell.toggleTheme}
        onToggleLocale={shell.toggleLocale}
        onToggleLeft={isMobile ? () => setMobilePanel((current) => current === "markets" ? undefined : "markets") : shell.toggleLeft}
        onToggleRight={isMobile ? () => setMobilePanel((current) => current === "instrument" ? undefined : "instrument") : shell.toggleRight}
        onSwapPanels={shell.swapPanels}
      />

      <main
        className={[
          "workspace",
          mode !== "chart" ? "strategy-workspace" : "",
          !actualLeftOpen && mode === "chart" ? "left-closed" : "",
          !actualRightOpen && mode === "chart" ? "right-closed" : ""
        ].filter(Boolean).join(" ")}
        style={{ "--left-panel-size": `${leftSize}px`, "--right-panel-size": `${rightSize}px` } as CSSProperties}
      >
        {mode === "chart" && !isMobile && (actualLeftOpen ? (shell.panelsSwapped ? statsPanel : watchlistPanel) : <span aria-hidden="true" />)}

        {mode === "chart" && isMobile && (
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
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="loading-banner">{shellText(locale, "loadingCatalog")}</div>}
          {mode === "chart" && (
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
              onLinkedCrosshairChange={setLinkedCrosshair}
              linkedTimeRange={linkedTimeRange}
              onLinkedTimeRangeChange={setLinkedTimeRange}
              onUpdateChart={shell.updateChart}
              activeChartId={shell.activeChartId}
              onActiveChartChange={shell.setActiveChartId}
              onMarketStreamChange={updatePaneStream}
              compareOverlays={compareOverlays}
              compareState={compareState}
              maximizeShortcut={appCommands.shortcuts.maximizeChart}
              previousChartShortcut={appCommands.shortcuts.previousChart}
              nextChartShortcut={appCommands.shortcuts.nextChart}
              primary={<ChartCanvas
              compactChrome={shell.layoutPreset !== "single"}
              candles={stream.candles}
              chartType={chartType}
              instrument={instrument}
              timeframe={timeframe}
              locale={locale}
              timeZone={shell.charts[0]?.timeZone}
              onTimeZoneChange={(timeZone) => shell.updateChart(shell.charts[0]?.id ?? "chart-1", { timeZone })}
              dataExchange={cryptoExchange}
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
                  symbol: instrument.symbol,
                  price,
                  direction: price >= (stream.candles.at(-1)?.close ?? price) ? "above" : "below"
                })
              }
              livePositions={livePositions}
              strategyName={artifactOverlay.activeOverlay?.name}
              strategySummary={artifactOverlay.activeOverlay?.summary}
              strategyInputs={artifactOverlay.activeOverlay?.inputs}
              onStrategyInputChange={artifactOverlay.updateInput}
              onClearStrategy={artifactOverlay.clear}
              customIndicators={chartCustomIndicators}
              strategies={chartStrategies}
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
              chartId={shell.charts[0]?.id}
              linkedCrosshair={linkedCrosshair}
              onLinkedCrosshairChange={setLinkedCrosshair}
              linkedTimeRange={linkedTimeRange}
              onLinkedTimeRangeChange={setLinkedTimeRange}
            />}
            />
          )}
          {mode === "trade" && (
            <Suspense fallback={<StrategyLoading locale={locale} />}>
              <TradingView strategies={strategyLibrary} catalog={catalog} locale={locale} />
            </Suspense>
          )}
          {mode === "strategy" && (
            <Suspense fallback={<StrategyLoading locale={locale} />}>
              <StrategyLab
                artifacts={strategyLibrary}
                activeArtifactId={activeArtifactId}
                onSelectArtifact={artifactLibrary.setActiveArtifactId}
                onCreateArtifact={artifactLibrary.createArtifact}
                onSaveArtifact={artifactLibrary.saveArtifact}
                onUseTemplate={artifactLibrary.useTemplate}
                onImportStrategy={artifactLibrary.importStrategy}
                onImportPineMany={artifactLibrary.importPineMany}
                onRollbackArtifact={artifactLibrary.rollbackArtifactVersion}
                onUpdateArtifactDependencies={artifactLibrary.updateArtifactDependencies}
                catalog={catalog}
                initialSymbol={symbol}
                initialTimeframe={timeframe}
                exchange={cryptoExchange}
                theme={theme}
                locale={locale}
                onApplyResult={artifactOverlay.applyBacktestResult}
                onShowOnChart={artifactOverlay.showOnChart}
                onOpenTrading={() => setMode("trade")}
              />
            </Suspense>
          )}
        </section>

        {mode === "chart" && !isMobile && (actualRightOpen ? (shell.panelsSwapped ? watchlistPanel : statsPanel) : <span aria-hidden="true" />)}
        {mode === "chart" && !isMobile && actualLeftOpen && (
          <PanelResizeHandle side="left" value={leftSize} min={180} max={520} label={shellText(locale, "resizeMarketsPanel")} onResize={shell.setLeftSize} />
        )}
        {mode === "chart" && !isMobile && actualRightOpen && (
          <PanelResizeHandle side="right" value={rightSize} min={220} max={520} label={shellText(locale, "resizeInstrumentPanel")} onResize={shell.setRightSize} />
        )}
      </main>

      <CommandPalette locale={locale} open={appCommands.paletteOpen} onClose={appCommands.closePalette} commands={appCommands.commands} />
      <ShortcutSettingsDialog locale={locale} open={appCommands.shortcutSettingsOpen} shortcuts={appCommands.shortcuts} onChange={appCommands.setShortcuts} onClose={appCommands.closeShortcutSettings} />
      <AlertToasts locale={locale} toasts={priceAlerts.toasts} decimalsFor={decimalsFor} onDismiss={priceAlerts.dismissToast} />
    </div>
  );
}

function StrategyLoading({ locale }: { locale: Locale }) {
  return (
    <div className="strategy-loading" role="status" aria-live="polite">
      <span className="loader-ring" aria-hidden="true" />
      <strong>{shellText(locale, "loadingStrategy")}</strong>
      <span>{shellText(locale, "preparingStrategy")}</span>
    </div>
  );
}
