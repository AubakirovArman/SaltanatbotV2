import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useChartArtifactOverlay } from "./chart/useChartArtifactOverlay";
import { AlertToasts } from "./components/AlertToasts";
import { ChartCanvas } from "./components/ChartCanvas";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import { TopBar } from "./components/TopBar";
import { Watchlist } from "./components/Watchlist";
import { useCatalog } from "./hooks/useCatalog";
import { useCompareSeries } from "./hooks/useCompareSeries";
import { useMarketStream } from "./hooks/useMarketStream";
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
  const { catalog, loading, error } = useCatalog();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [asset, setAsset] = useState<AssetClass | "all">("all");
  const [mode, setMode] = useState<AppMode>("chart");
  const [indicators, setIndicators] = useState(initialWorkspaceState.indicators);
  const shell = useAppShell({
    symbol, setSymbol, timeframe, setTimeframe, chartType, setChartType,
    setMode, indicators, setIndicators
  });
  const { cryptoExchange, theme, locale, leftOpen, rightOpen, workspaces, compareOverlays } = shell;
  const openStrategyWorkspace = useCallback(() => setMode("strategy"), []);
  const artifactLibrary = useArtifactLibrary({
    initialArtifacts: initialWorkspaceState.strategyLibrary,
    setIndicators,
    openStrategyWorkspace
  });
  const strategyLibrary = artifactLibrary.artifacts;
  const activeArtifactId = artifactLibrary.activeArtifactId;
  const stream = useMarketStream(symbol, timeframe, cryptoExchange);
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

  const allSymbols = useMemo(() => catalog?.instruments.map((item) => item.symbol) ?? [], [catalog]);
  const sparklines = useSparklines(allSymbols, timeframe, cryptoExchange);

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
  const prices = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [sym, series] of Object.entries(sparklines)) {
      if (series?.last != null) map[sym] = series.last;
    }
    if (latestClose !== undefined) map[symbol] = latestClose;
    return map;
  }, [sparklines, latestClose, symbol]);

  const decimalsFor = useCallback(
    (sym: string) => catalog?.instruments.find((item) => item.symbol === sym)?.decimals ?? 2,
    [catalog]
  );
  const priceAlerts = usePriceAlerts(prices, decimalsFor);
  const livePositions = useLivePositions(instrument.symbol);
  const appCommands = useAppCommands({
    catalog,
    indicators,
    setIndicators,
    setSymbol,
    setTimeframe,
    setChartType,
    setMode,
    toggleTheme: shell.toggleTheme,
    alerts: priceAlerts.alerts,
    removeAlert: priceAlerts.removeAlert
  });

  const chartCustomIndicators = artifactLibrary.customIndicators;
  const chartStrategies = artifactLibrary.strategies;

  return (
    <div className="terminal-shell">
      <TopBar
        catalog={catalog}
        instrument={instrument}
        timeframe={timeframe}
        chartType={chartType}
        mode={mode}
        connection={stream.connection}
        theme={theme}
        locale={locale}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        workspaces={workspaces}
        onSaveWorkspace={shell.saveWorkspace}
        onApplyWorkspace={shell.applyWorkspace}
        onDeleteWorkspace={shell.deleteWorkspace}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onModeChange={setMode}
        onStrategyWarmup={warmStrategyLab}
        onOpenPalette={appCommands.openPalette}
        onToggleTheme={shell.toggleTheme}
        onToggleLocale={shell.toggleLocale}
        onToggleLeft={shell.toggleLeft}
        onToggleRight={shell.toggleRight}
      />

      <main
        className={[
          "workspace",
          mode !== "chart" ? "strategy-workspace" : "",
          !leftOpen && mode === "chart" ? "left-closed" : "",
          !rightOpen && mode === "chart" ? "right-closed" : ""
        ].filter(Boolean).join(" ")}
      >
        {mode === "chart" && leftOpen && (
          <Watchlist
            instruments={instruments}
            selectedSymbol={symbol}
            selectedAsset={asset}
            latest={stream.candles.at(-1)}
            sparklines={sparklines}
            cryptoExchange={cryptoExchange}
            onSelectSymbol={setSymbol}
            onSelectAsset={setAsset}
            onSelectExchange={shell.setCryptoExchange}
          />
        )}
        {mode === "chart" && !leftOpen && <span aria-hidden="true" />}

        <section className="chart-panel">
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="loading-banner">Loading market catalog</div>}
          {mode === "chart" && (
            <ChartCanvas
              candles={stream.candles}
              chartType={chartType}
              instrument={instrument}
              timeframe={timeframe}
              locale={locale}
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
            />
          )}
          {mode === "trade" && (
            <Suspense fallback={<StrategyLoading />}>
              <TradingView strategies={strategyLibrary} catalog={catalog} locale={locale} />
            </Suspense>
          )}
          {mode === "strategy" && (
            <Suspense fallback={<StrategyLoading />}>
              <StrategyLab
                artifacts={strategyLibrary}
                activeArtifactId={activeArtifactId}
                onSelectArtifact={artifactLibrary.setActiveArtifactId}
                onCreateArtifact={artifactLibrary.createArtifact}
                onSaveArtifact={artifactLibrary.saveArtifact}
                onUseTemplate={artifactLibrary.useTemplate}
                onImportStrategy={artifactLibrary.importStrategy}
                onImportPineMany={artifactLibrary.importPineMany}
                catalog={catalog}
                initialSymbol={symbol}
                initialTimeframe={timeframe}
                exchange={cryptoExchange}
                theme={theme}
                locale={locale}
                onApplyResult={artifactOverlay.applyBacktestResult}
                onShowOnChart={artifactOverlay.showOnChart}
              />
            </Suspense>
          )}
        </section>

        {mode === "chart" && rightOpen && (
          <StatsPanel
            instrument={instrument}
            candles={stream.candles}
            provider={stream.provider}
            connection={stream.connection}
            message={stream.message}
            latencyMs={stream.latencyMs}
            alerts={priceAlerts.alerts}
            onAddAlert={priceAlerts.addAlert}
            onRemoveAlert={priceAlerts.removeAlert}
            onResetAlert={priceAlerts.resetAlert}
          />
        )}
        {mode === "chart" && !rightOpen && <span aria-hidden="true" />}
      </main>

      <CommandPalette open={appCommands.paletteOpen} onClose={appCommands.closePalette} commands={appCommands.commands} />
      <AlertToasts toasts={priceAlerts.toasts} decimalsFor={decimalsFor} onDismiss={priceAlerts.dismissToast} />
    </div>
  );
}

function StrategyLoading() {
  return (
    <div className="strategy-loading" role="status" aria-live="polite">
      <span className="loader-ring" aria-hidden="true" />
      <strong>Loading Strategy Lab</strong>
      <span>Preparing Blockly blocks and strategy compiler preview.</span>
    </div>
  );
}
