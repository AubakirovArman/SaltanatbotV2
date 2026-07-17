import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useChartArtifactOverlay } from "./chart/useChartArtifactOverlay";
import { AlertToasts } from "./components/AlertToasts";
import { CommandPalette } from "./components/CommandPalette";
import { TopBar } from "./components/TopBar";
import { ShortcutSettingsDialog } from "./components/ShortcutSettingsDialog";
import { OfflineResearchDialog } from "./components/OfflineResearchDialog";
import type { LinkedCrosshair, LinkedTimeRange } from "./chart/types";
import { useCatalog } from "./hooks/useCatalog";
import type { ConnectionState } from "./hooks/useMarketStream";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "./hooks/useMediaQuery";
import { usePriceAlerts } from "./hooks/usePriceAlerts";
import { loadStrategyLab, warmStrategyLab } from "./strategy/loadStrategyLab";
import { loadTradingView } from "./trading/loadTradingView";
import { loadArbitrageScreener } from "./arbitrage/loadArbitrageScreener";
import { MARKET_OPPORTUNITY_HANDOFF_EVENT } from "./arbitrage/marketOpportunityHandoffEvent";
import { loadInitialWorkspaceState } from "./strategy/storage";
import { useArtifactLibrary } from "./strategy/useArtifactLibrary";
import type { AssetClass, Candle, ChartDataRoute, ChartType, Instrument, Timeframe } from "./types";
import { useAppShell, type AppMode } from "./app/useAppShell";
import { useAppCommands } from "./app/useAppCommands";
import { ChartWorkspaceRuntime } from "./app/ChartWorkspaceRuntime";
import { shellText } from "./i18n/shell";
import { automationText } from "./i18n/automation";
import type { Locale } from "./i18n";
import { localized } from "./i18n";
import { loadLastChartSession } from "./app/chartSession";
import { pickDistinctMarketSymbols } from "./app/distinctMarkets";
import { launchView } from "./app/launchView";
import { createPwaFileLaunchBatch, registerPwaFileLaunch, type PwaFileLaunchBatch, type PwaLaunchWindow } from "./pwa/fileLaunch";
import { PwaFileLaunchDialog } from "./pwa/PwaFileLaunchDialog";
import { clearPwaShareTargetLaunch, discardPwaShareTarget, loadPwaShareTarget, parsePwaShareTargetLaunch } from "./pwa/shareTarget";
import { useAuth } from "./auth/AuthRoot";
import { PriceAlertFeed } from "./market/PriceAlertFeed";
import { recordBrowserRender } from "./performance/browserProbe";
import type { WorkspaceStrategySelection } from "./workspace/workspaces";
import { artifactHash } from "./strategy/artifactLibraryModel";
import { useOnboarding } from "./onboarding/useOnboarding";
import { OnboardingDialog } from "./onboarding/OnboardingDialog";
import { useOnboardingFlow } from "./onboarding/useOnboardingFlow";
import { usePwaLifecycle } from "./pwa/usePwaLifecycle";

const StrategyLab = lazy(loadStrategyLab);
const TradingView = lazy(loadTradingView);
const ArbitrageScreener = lazy(loadArbitrageScreener);

interface QueuedPwaLaunch {
  batch: PwaFileLaunchBatch;
  approved: boolean;
  shareToken?: string;
  clearShareLaunch?: boolean;
}

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
  recordBrowserRender("App");
  const accountAuth = useAuth();
  const onboarding = useOnboarding(accountAuth.user?.id, accountAuth.authRequired && !!accountAuth.user);
  const pwa = usePwaLifecycle();
  const localStorageOwner = accountAuth.authRequired ? (accountAuth.user?.id ?? "") : undefined;
  const [initialWorkspaceState] = useState(() => loadInitialWorkspaceState(localStorageOwner));
  const [initialChartSession] = useState(() => loadLastChartSession({ symbol: "BTCUSDT", timeframe: "1m", chartType: "candles" }, localStorageOwner));
  const initialPrimaryChart = initialChartSession.charts[0];
  const { catalog, loading, error } = useCatalog();
  const [symbol, setSymbol] = useState(initialPrimaryChart.symbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(initialPrimaryChart.timeframe);
  const [chartType, setChartType] = useState<ChartType>(initialPrimaryChart.chartType);
  const [asset, setAsset] = useState<AssetClass | "all">("all");
  const [mode, setMode] = useState<AppMode>(launchView);
  const openStrategyWorkspace = useCallback(() => setMode("strategy"), []);
  const [robotsCenterRequest, setRobotsCenterRequest] = useState(0);
  const [newPaperBotRequest, setNewPaperBotRequest] = useState(0);
  const [offlineResearchOpen, setOfflineResearchOpen] = useState(false);
  const [launchedFiles, setLaunchedFiles] = useState<QueuedPwaLaunch[]>([]);
  const shareTargetLoadStarted = useRef(false);
  const [indicators, setIndicators] = useState(initialWorkspaceState.indicators);
  const [linkedCrosshair, setLinkedCrosshair] = useState<LinkedCrosshair>();
  const [linkedTimeRange, setLinkedTimeRange] = useState<LinkedTimeRange>();
  const [chartConnection, setChartConnection] = useState<ConnectionState>("connecting");
  const [hasPrimaryCandles, setHasPrimaryCandles] = useState(false);
  const primaryCandlesRef = useRef<Candle[]>([]);
  const [mobilePanel, setMobilePanel] = useState<"markets" | "instrument">();
  const artifactLibrary = useArtifactLibrary({
    initialArtifacts: initialWorkspaceState.strategyLibrary,
    setIndicators,
    openStrategyWorkspace,
    storageOwnerId: localStorageOwner
  });
  const strategyLibrary = artifactLibrary.artifacts;
  const activeArtifactId = artifactLibrary.activeArtifactId;
  const selectedStrategy = useMemo(() => {
    const artifact = strategyLibrary.find((item) => item.id === activeArtifactId);
    if (!artifact || artifact.kind !== "strategy") return undefined;
    return {
      id: artifact.id,
      revision: Math.max(1, artifact.version ?? 1),
      hash: artifact.hash ?? artifactHash(artifact),
      parameters: { ...(artifactLibrary.inputOverrides[artifact.id] ?? {}) }
    };
  }, [activeArtifactId, artifactLibrary.inputOverrides, strategyLibrary]);
  const restoreWorkspaceStrategy = useCallback(
    (selection?: WorkspaceStrategySelection) => {
      if (!selection) return "none" as const;
      const artifact = strategyLibrary.find((candidate) => candidate.id === selection.id && candidate.kind === "strategy");
      if (!artifact) return "missing" as const;
      if (Math.max(1, artifact.version ?? 1) !== selection.revision) return "revision_mismatch" as const;
      if (selection.hash && (artifact.hash ?? artifactHash(artifact)).toLowerCase() !== selection.hash.toLowerCase()) return "hash_mismatch" as const;
      artifactLibrary.setActiveArtifactId(selection.id);
      artifactLibrary.setInputOverrides((current) => ({ ...current, [selection.id]: { ...selection.parameters } }));
      return "restored" as const;
    },
    [artifactLibrary.setActiveArtifactId, artifactLibrary.setInputOverrides, strategyLibrary]
  );
  const shell = useAppShell({
    symbol,
    setSymbol,
    timeframe,
    setTimeframe,
    chartType,
    setChartType,
    mode,
    setMode,
    indicators,
    setIndicators,
    selectedStrategy,
    onRestoreStrategy: restoreWorkspaceStrategy,
    initialChartSession
  });
  const { cryptoExchange, theme, locale, leftOpen, rightOpen, leftSize, rightSize, workspaces, activeWorkspaceId } = shell;
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  useEffect(() => {
    if (!pwa.capabilities.offlineResearchSupported) {
      setOfflineResearchOpen(false);
    }
  }, [pwa.capabilities.offlineResearchSupported]);
  useEffect(() => {
    const workspace = mode === "chart" ? automationText(locale, "monitoring") : mode === "screener" ? automationText(locale, "screener") : `${automationText(locale, "automation")} · ${automationText(locale, mode === "strategy" ? "strategies" : "robots")}`;
    document.title = `${workspace} · SaltanatbotV2`;
  }, [locale, mode]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (mode === "chart") url.searchParams.delete("view");
    else url.searchParams.set("view", mode);
    const next = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, "", next);
  }, [mode]);
  useEffect(() => {
    if (!isMobile || mode !== "chart") setMobilePanel(undefined);
  }, [isMobile, mode]);
  useEffect(() => {
    let active = true;
    const openOpportunity = () => setMode("trade");
    window.addEventListener(MARKET_OPPORTUNITY_HANDOFF_EVENT, openOpportunity);
    void import("./arbitrage/marketOpportunityHandoff")
      .then(({ readMarketOpportunityHandoff }) => {
        if (active && readMarketOpportunityHandoff()) openOpportunity();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener(MARKET_OPPORTUNITY_HANDOFF_EVENT, openOpportunity);
    };
  }, []);
  useEffect(() => {
    registerPwaFileLaunch(window as unknown as PwaLaunchWindow, (batch) => {
      setLaunchedFiles((current) => [...current, { batch, approved: false }]);
    });
  }, []);
  useEffect(() => {
    if (shareTargetLoadStarted.current) return;
    const launch = parsePwaShareTargetLaunch();
    if (launch.kind === "none") return;
    shareTargetLoadStarted.current = true;
    if (launch.kind === "error") {
      setLaunchedFiles((current) => [
        ...current,
        {
          batch: createPwaFileLaunchBatch("share_target", [], [{ reason: "expired" }]),
          approved: false,
          clearShareLaunch: true
        }
      ]);
      return;
    }
    void loadPwaShareTarget(launch.token).then((batch) => {
      setLaunchedFiles((current) => [...current, { batch, approved: false, shareToken: launch.token, clearShareLaunch: true }]);
    });
  }, []);
  const consumeLaunchedFiles = useCallback(() => {
    const current = launchedFiles[0];
    if (!current) return;
    if (current.shareToken) void discardPwaShareTarget(current.shareToken);
    if (current.clearShareLaunch) clearPwaShareTargetLaunch();
    setLaunchedFiles((queue) => (queue[0]?.batch.id === current.batch.id ? queue.slice(1) : queue));
  }, [launchedFiles]);
  const approveLaunchedFiles = useCallback(() => {
    const current = launchedFiles[0];
    if (!current) return;
    setLaunchedFiles((queue) => queue.map((item, index) => (index === 0 ? { ...item, approved: true } : item)));
    setMode("strategy");
    warmStrategyLab();
  }, [launchedFiles]);
  const primaryChart = shell.charts[0];
  const primaryExchange = primaryChart?.exchange ?? cryptoExchange;
  const activeChart = shell.activeChart ?? shell.charts[0];
  const activeInstrument = catalog?.instruments.find((item) => item.symbol === activeChart?.symbol) ?? {
    ...fallbackInstrument,
    symbol: activeChart?.symbol ?? fallbackInstrument.symbol,
    displayName: activeChart?.symbol ?? fallbackInstrument.displayName
  };
  const setActiveSymbol = useCallback((nextSymbol: string) => shell.updateActiveChart({ symbol: nextSymbol }), [shell.updateActiveChart]);
  const setActiveTimeframe = useCallback((nextTimeframe: Timeframe) => shell.updateActiveChart({ timeframe: nextTimeframe }), [shell.updateActiveChart]);
  const setActiveChartType = useCallback((nextChartType: ChartType) => shell.updateActiveChart({ chartType: nextChartType }), [shell.updateActiveChart]);
  const showChart = useCallback((nextSymbol: string, nextTimeframe: Timeframe) => {
    setSymbol(nextSymbol);
    setTimeframe(nextTimeframe);
    setMode("chart");
  }, []);
  const getPrimaryCandles = useCallback(() => primaryCandlesRef.current, []);
  const artifactOverlay = useChartArtifactOverlay({
    artifacts: strategyLibrary,
    inputOverrides: artifactLibrary.inputOverrides,
    setInputOverrides: artifactLibrary.setInputOverrides,
    symbol,
    timeframe,
    getCandles: getPrimaryCandles,
    exchange: primaryExchange,
    showChart
  });

  const instrument = catalog?.instruments.find((item) => item.symbol === symbol) ?? fallbackInstrument;
  const distinctMarketSymbols = useMemo(() => pickDistinctMarketSymbols(symbol, catalog?.instruments ?? []), [catalog, symbol]);
  const decimalsFor = useCallback((sym: string) => catalog?.instruments.find((item) => item.symbol === sym)?.decimals ?? 2, [catalog]);
  const legacyAlertRoute = useMemo<ChartDataRoute>(() => {
    const exchange = activeChart?.exchange ?? cryptoExchange;
    return {
      exchange,
      marketType: activeChart?.marketType ?? "spot",
      priceType: exchange === "bybit" ? "last" : (activeChart?.priceType ?? "last")
    };
  }, [activeChart?.exchange, activeChart?.marketType, activeChart?.priceType, cryptoExchange]);
  const priceAlerts = usePriceAlerts(decimalsFor, legacyAlertRoute);
  const onboardingFlow = useOnboardingFlow({
    onboarding,
    mode,
    chartConnection,
    hasPrimaryCandles,
    alerts: priceAlerts.alerts,
    isMobile,
    rightOpen: shell.rightOpen,
    setMode,
    setMobilePanel,
    setNewPaperBotRequest,
    createWorkspaceTemplate: shell.createWorkspaceTemplate,
    toggleRight: shell.toggleRight
  });
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
    removeAlert: priceAlerts.removeAlert,
    storageOwnerId: localStorageOwner
  });
  const actualLeftOpen = shell.panelsSwapped ? rightOpen : leftOpen;
  const actualRightOpen = shell.panelsSwapped ? leftOpen : rightOpen;
  const openRobotsCenter = useCallback(() => {
    setRobotsCenterRequest((request) => request + 1);
    setMode("trade");
  }, []);

  return (
    <div className="terminal-shell">
      <a className="skip-link" href="#main-workspace">
        {localized(locale, { en: "Skip to workspace", ru: "Перейти к рабочей области", kk: "Жұмыс аймағына өту" })}
      </a>
      <TopBar
        catalog={catalog}
        instrument={activeInstrument}
        timeframe={activeChart?.timeframe ?? timeframe}
        chartType={activeChart?.chartType ?? chartType}
        mode={mode}
        connection={mode === "chart" ? chartConnection : "idle"}
        theme={theme}
        locale={locale}
        leftOpen={isMobile ? mobilePanel === "markets" : leftOpen}
        rightOpen={isMobile ? mobilePanel === "instrument" : rightOpen}
        mobilePanels={isMobile}
        panelsSwapped={shell.panelsSwapped}
        workspaces={workspaces}
        workspaceSyncStatus={shell.workspaceSyncStatus}
        workspaceStrategyRestore={shell.workspaceStrategyRestore}
        workspaceMigrationMissingIndicators={shell.workspaceMigrationMissingIndicators}
        activeWorkspaceId={activeWorkspaceId}
        layoutPreset={shell.layoutPreset}
        onSaveWorkspace={shell.saveWorkspace}
        onApplyWorkspace={shell.applyWorkspace}
        onDeleteWorkspace={shell.deleteWorkspace}
        onRestoreWorkspace={shell.restoreArchivedWorkspace}
        onPurgeWorkspace={shell.purgeArchivedWorkspace}
        onRenameWorkspace={shell.renameWorkspace}
        onDuplicateWorkspace={shell.duplicateWorkspace}
        onCreateWorkspaceTemplate={shell.createWorkspaceTemplate}
        canCreatePaperWorkspace={shell.canCreatePaperWorkspace}
        serverWorkspaceHistory={accountAuth.authRequired}
        onExportWorkspace={shell.exportWorkspace}
        onImportWorkspace={shell.importWorkspace}
        onRollbackWorkspace={shell.rollbackWorkspaceVersion}
        onRetryWorkspaceSync={shell.retryWorkspaceSync}
        onResolveWorkspaceConflict={shell.resolveWorkspaceConflict}
        onLayoutPresetChange={shell.setLayoutPreset}
        canUseDistinctMarkets={distinctMarketSymbols.length === 4}
        onDistinctMarkets={() => shell.setDistinctMarketLayout(distinctMarketSymbols)}
        onTimeframeChange={setActiveTimeframe}
        onChartTypeChange={setActiveChartType}
        onModeChange={setMode}
        onOpenRobotsCenter={openRobotsCenter}
        onStrategyWarmup={warmStrategyLab}
        onOpenPalette={appCommands.openPalette}
        onOpenShortcutSettings={appCommands.openShortcutSettings}
        onOpenOfflineResearch={pwa.capabilities.offlineResearchSupported ? () => setOfflineResearchOpen(true) : undefined}
        onOpenGettingStarted={accountAuth.authRequired && accountAuth.user ? () => void onboardingFlow.reopen() : undefined}
        onToggleTheme={shell.toggleTheme}
        onToggleLocale={shell.toggleLocale}
        onToggleLeft={isMobile ? () => setMobilePanel((current) => (current === "markets" ? undefined : "markets")) : shell.toggleLeft}
        onToggleRight={isMobile ? () => setMobilePanel((current) => (current === "instrument" ? undefined : "instrument")) : shell.toggleRight}
        onSwapPanels={shell.swapPanels}
      />

      <main
        id="main-workspace"
        tabIndex={-1}
        className={["workspace", mode !== "chart" ? "strategy-workspace" : "", !actualLeftOpen && mode === "chart" ? "left-closed" : "", !actualRightOpen && mode === "chart" ? "right-closed" : ""].filter(Boolean).join(" ")}
        style={{ "--left-panel-size": `${leftSize}px`, "--right-panel-size": `${rightSize}px` } as CSSProperties}
      >
        {mode === "chart" ? (
          <ChartWorkspaceRuntime
            catalog={catalog}
            loading={loading}
            error={error}
            symbol={symbol}
            timeframe={timeframe}
            chartType={chartType}
            asset={asset}
            setAsset={setAsset}
            indicators={indicators}
            setIndicators={setIndicators}
            shell={shell}
            isMobile={isMobile}
            mobilePanel={mobilePanel}
            setMobilePanel={setMobilePanel}
            locale={locale}
            theme={theme}
            primaryInstrument={instrument}
            activeInstrument={activeInstrument}
            artifactLibrary={artifactLibrary}
            artifactOverlay={artifactOverlay}
            priceAlerts={priceAlerts}
            storageOwnerId={localStorageOwner}
            primaryCandlesRef={primaryCandlesRef}
            onConnectionChange={setChartConnection}
            onPrimaryCandlesAvailabilityChange={setHasPrimaryCandles}
            linkedCrosshair={linkedCrosshair}
            onLinkedCrosshairChange={setLinkedCrosshair}
            linkedTimeRange={linkedTimeRange}
            onLinkedTimeRangeChange={setLinkedTimeRange}
            maximizeShortcut={appCommands.shortcuts.maximizeChart}
            previousChartShortcut={appCommands.shortcuts.previousChart}
            nextChartShortcut={appCommands.shortcuts.nextChart}
          />
        ) : (
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
            {mode === "trade" && (
              <Suspense fallback={<WorkspaceLoading locale={locale} mode="trade" />}>
                <TradingView strategies={strategyLibrary} catalog={catalog} locale={locale} portfolioRequest={robotsCenterRequest} newBotRequest={newPaperBotRequest} onPaperBotCreated={onboardingFlow.onPaperBotCreated} />
              </Suspense>
            )}
            {mode === "screener" && (
              <Suspense fallback={<WorkspaceLoading locale={locale} mode="screener" />}>
                <ArbitrageScreener
                  locale={locale}
                  onOpenChart={(target) => {
                    shell.updateActiveChart({ symbol: target.symbol, exchange: target.exchange, marketType: target.marketType, priceType: target.priceType });
                    shell.setCryptoExchange(target.exchange);
                    setMode("chart");
                  }}
                />
              </Suspense>
            )}
            {mode === "strategy" && (
              <Suspense fallback={<WorkspaceLoading locale={locale} mode="strategy" />}>
                <StrategyLab
                  artifacts={strategyLibrary}
                  activeArtifactId={activeArtifactId}
                  onSelectArtifact={artifactLibrary.setActiveArtifactId}
                  onCreateArtifact={artifactLibrary.createArtifact}
                  onSaveArtifact={artifactLibrary.saveArtifact}
                  onUseTemplate={artifactLibrary.useTemplate}
                  onImportStrategy={artifactLibrary.importStrategy}
                  onImportPlugin={artifactLibrary.importPlugin}
                  onUninstallPlugin={artifactLibrary.uninstallPlugin}
                  onImportPineMany={artifactLibrary.importPineMany}
                  launchedBatch={launchedFiles[0]?.approved ? launchedFiles[0].batch : undefined}
                  onLaunchedBatchConsumed={consumeLaunchedFiles}
                  onRollbackArtifact={artifactLibrary.rollbackArtifactVersion}
                  onUpdateArtifactDependencies={artifactLibrary.updateArtifactDependencies}
                  catalog={catalog}
                  initialSymbol={symbol}
                  initialTimeframe={timeframe}
                  exchange={cryptoExchange}
                  theme={theme}
                  locale={locale}
                  storageOwnerId={localStorageOwner}
                  onApplyResult={artifactOverlay.applyBacktestResult}
                  onBacktestCompleted={onboardingFlow.onBacktestCompleted}
                  onShowOnChart={artifactOverlay.showOnChart}
                  onOpenTrading={() => setMode("trade")}
                />
              </Suspense>
            )}
          </section>
        )}
      </main>

      <PriceAlertFeed alerts={priceAlerts.alerts} evaluatePrices={priceAlerts.evaluatePrices} />
      <CommandPalette locale={locale} open={appCommands.paletteOpen} onClose={appCommands.closePalette} commands={appCommands.commands} />
      <ShortcutSettingsDialog locale={locale} open={appCommands.shortcutSettingsOpen} shortcuts={appCommands.shortcuts} onChange={appCommands.setShortcuts} onClose={appCommands.closeShortcutSettings} />
      {pwa.capabilities.offlineResearchSupported && <OfflineResearchDialog locale={locale} open={offlineResearchOpen} pwa={pwa} onClose={() => setOfflineResearchOpen(false)} />}
      <OnboardingDialog
        locale={locale}
        open={onboarding.phase === "ready" && onboarding.state?.status === "not_started"}
        busy={onboarding.busy}
        error={onboarding.error}
        canCreatePaperRobot={shell.canCreatePaperWorkspace}
        onSelect={(goal) => void onboardingFlow.selectGoal(goal)}
        onDismiss={() => void onboarding.dismiss()}
        onRetry={onboarding.retry}
      />
      {launchedFiles[0] && !launchedFiles[0].approved && <PwaFileLaunchDialog locale={locale} batch={launchedFiles[0].batch} onClose={consumeLaunchedFiles} onReview={approveLaunchedFiles} />}
      <AlertToasts locale={locale} toasts={priceAlerts.toasts} decimalsFor={decimalsFor} onDismiss={priceAlerts.dismissToast} />
    </div>
  );
}

function WorkspaceLoading({ locale, mode }: { locale: Locale; mode: Exclude<AppMode, "chart"> }) {
  const title = mode === "trade" ? localized(locale, { en: "Loading robots", ru: "Загрузка роботов", kk: "Роботтар жүктелуде" }) : mode === "screener" ? localized(locale, { en: "Loading screener", ru: "Загрузка скринера", kk: "Скринер жүктелуде" }) : shellText(locale, "loadingStrategy");
  return (
    <div className="strategy-loading" role="status" aria-live="polite">
      <span className="loader-ring" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{shellText(locale, "preparingStrategy")}</span>
    </div>
  );
}
