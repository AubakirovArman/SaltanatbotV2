import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { IndicatorConfig } from "./chart/indicatorTypes";
import type { ChartMarker, ChartPlot, ChartTrade } from "./chart/types";
import { AlertToasts } from "./components/AlertToasts";
import { ChartCanvas } from "./components/ChartCanvas";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import { TopBar } from "./components/TopBar";
import { Watchlist } from "./components/Watchlist";
import { useCatalog } from "./hooks/useCatalog";
import { useMarketStream } from "./hooks/useMarketStream";
import { usePriceAlerts } from "./hooks/usePriceAlerts";
import { useSparklines } from "./hooks/useSparklines";
import type { StrategyArtifact, StrategyArtifactKind } from "./strategy/library";
import { createNewArtifact, indicatorArtifactId, indicatorToArtifact } from "./strategy/library";
import { loadStrategyLab, warmStrategyLab } from "./strategy/loadStrategyLab";
import { loadTradingView, warmTradingView } from "./trading/loadTradingView";
import { clearShareHash, readSharedFromHash } from "./strategy/share";
import { loadInitialWorkspaceState, storeIndicators, storeStrategyLibrary } from "./strategy/storage";
import type { AssetClass, ChartType, DataExchange, Instrument, Timeframe } from "./types";

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
  const [cryptoExchange, setCryptoExchange] = useState<DataExchange>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("mf:cryptoExchange") === "bybit") ? "bybit" : "binance"
  );
  const [mode, setMode] = useState<"chart" | "strategy" | "trade">("chart");
  const [indicators, setIndicators] = useState(initialWorkspaceState.indicators);
  const [strategyLibrary, setStrategyLibrary] = useState(initialWorkspaceState.strategyLibrary);
  const [activeArtifactId, setActiveArtifactId] = useState("strategy:price-cross-ema");
  const [overlay, setOverlay] = useState<{
    id?: string;
    name: string;
    signals: ChartMarker[];
    trades: ChartTrade[];
    plots?: ChartPlot[];
    symbol: string;
    timeframe: Timeframe;
  }>();
  const [chartFocus, setChartFocus] = useState<number>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("mf:theme") === "light") ? "light" : "dark"
  );
  const [leftOpen, setLeftOpen] = useState(() => readPanel("mf:panel:left", true));
  const [rightOpen, setRightOpen] = useState(() => readPanel("mf:panel:right", true));
  const stream = useMarketStream(symbol, timeframe, cryptoExchange);

  useEffect(() => {
    try {
      localStorage.setItem("mf:cryptoExchange", cryptoExchange);
    } catch {
      // ignore storage failures
    }
  }, [cryptoExchange]);

  useEffect(() => writePanel("mf:panel:left", leftOpen), [leftOpen]);
  useEffect(() => writePanel("mf:panel:right", rightOpen), [rightOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mf:theme", theme);
    } catch {
      // ignore storage failures
    }
  }, [theme]);

  // The strategy overlay is bound to the market/interval it was computed on.
  const activeOverlay =
    overlay && overlay.symbol === symbol && overlay.timeframe === timeframe ? overlay : undefined;

  useEffect(() => {
    const run = () => warmStrategyLab();
    const id = window.setTimeout(run, 1800);
    return () => window.clearTimeout(id);
  }, []);

  // Import a strategy shared via URL hash (#s=...) as a remixable copy.
  useEffect(() => {
    const shared = readSharedFromHash();
    if (!shared) return;
    const now = Date.now();
    const artifact: StrategyArtifact = {
      id: `strategy:remix-${now}`,
      kind: "strategy",
      name: `${shared.name} (remix)`,
      description: "Imported from a shared link.",
      xml: shared.xml,
      createdAt: now,
      updatedAt: now
    };
    setStrategyLibrary((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    setMode("strategy");
    warmStrategyLab();
    clearShareHash();
  }, []);

  useEffect(() => {
    storeIndicators(indicators);
  }, [indicators]);

  useEffect(() => {
    storeStrategyLibrary(strategyLibrary);
  }, [strategyLibrary]);

  const instrument =
    catalog?.instruments.find((item) => item.symbol === symbol) ?? fallbackInstrument;

  const instruments = useMemo(() => {
    const list = catalog?.instruments ?? [fallbackInstrument];
    return asset === "all" ? list : list.filter((item) => item.assetClass === asset);
  }, [asset, catalog]);

  const allSymbols = useMemo(() => catalog?.instruments.map((item) => item.symbol) ?? [], [catalog]);
  const sparklines = useSparklines(allSymbols, timeframe, cryptoExchange);

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

  const chartStrategies = useMemo(
    () => strategyLibrary.filter((item) => item.kind === "strategy").map((item) => ({ id: item.id, name: item.name, description: item.description })),
    [strategyLibrary]
  );

  // Run a saved strategy on the current chart data and overlay its signals/trades.
  const addStrategyToChart = async (id: string) => {
    const artifact = strategyLibrary.find((item) => item.id === id);
    if (!artifact) return;
    const [{ compileXmlToIr }, backtest] = await Promise.all([
      import("./strategy/compileArtifact"),
      import("./strategy/backtest")
    ]);
    const compiled = compileXmlToIr(artifact.xml);
    if (!compiled.ir) return;
    // Show the strategy's plotted lines + every signal point, plus the trades it took.
    const preview = backtest.previewStrategy(compiled.ir, stream.candles);
    const result = backtest.runBacktest(compiled.ir, stream.candles, backtest.DEFAULT_CONFIG);
    setOverlay({ id, name: artifact.name, plots: preview.plots, signals: preview.signals, trades: result.trades, symbol, timeframe });
    const times = [...preview.signals.map((s) => s.time), ...result.trades.map((t) => t.exitTime)];
    setChartFocus(times.length ? Math.max(...times) : Date.now());
  };

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    (catalog?.instruments ?? []).forEach((item) =>
      list.push({
        id: `sym-${item.symbol}`,
        group: "Symbol",
        label: `${item.symbol} · ${item.displayName}`,
        hint: item.exchange,
        run: () => {
          setSymbol(item.symbol);
          setMode("chart");
        }
      })
    );
    (catalog?.timeframes ?? []).forEach((tf, i) =>
      list.push({ id: `tf-${tf}`, group: "Timeframe", label: tf, hint: `key ${i + 1}`, run: () => setTimeframe(tf) })
    );
    (catalog?.chartTypes ?? []).forEach((ct) =>
      list.push({ id: `ct-${ct}`, group: "Chart type", label: ct, run: () => { setChartType(ct); setMode("chart"); } })
    );
    list.push({ id: "view-chart", group: "View", label: "Open Chart", run: () => setMode("chart") });
    list.push({ id: "view-strategy", group: "View", label: "Open Strategy Lab", run: () => { warmStrategyLab(); setMode("strategy"); } });
    list.push({ id: "view-trade", group: "View", label: "Open Trading", run: () => { warmTradingView(); setMode("trade"); } });
    list.push({ id: "theme", group: "View", label: "Toggle light / dark theme", run: () => setTheme((current) => (current === "dark" ? "light" : "dark")) });
    return list;
  }, [catalog]);

  // Command palette (⌘K) + timeframe number hotkeys.
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
      const digit = ["1", "2", "3", "4", "5", "6"].indexOf(event.key);
      if (digit >= 0 && catalog?.timeframes[digit]) setTimeframe(catalog.timeframes[digit]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catalog]);

  const openIndicatorLogic = (indicator: IndicatorConfig) => {
    const artifact = indicatorToArtifact(indicator);
    setStrategyLibrary((current) => upsertArtifact(current, artifact));
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
    setMode("strategy");
  };

  const saveStrategyArtifact = (artifact: StrategyArtifact) => {
    setStrategyLibrary((current) => upsertArtifact(current, artifact));
    if (!artifact.linkedIndicatorId) return;
    setIndicators((current) => current.map((indicator) => (
      indicator.id === artifact.linkedIndicatorId
        ? { ...indicator, logicCode: artifact.code, logicXml: artifact.xml }
        : indicator
    )));
  };

  const createArtifact = (kind: StrategyArtifactKind) => {
    const count = strategyLibrary.filter((item) => item.kind === kind).length + 1;
    const artifact = createNewArtifact(kind, count);
    setStrategyLibrary((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

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
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onModeChange={setMode}
        onStrategyWarmup={warmStrategyLab}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        onToggleLeft={() => setLeftOpen((open) => !open)}
        onToggleRight={() => setRightOpen((open) => !open)}
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
            onSelectExchange={setCryptoExchange}
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
              indicators={indicators}
              onIndicatorsChange={setIndicators}
              onEditIndicatorLogic={openIndicatorLogic}
              signals={activeOverlay?.signals}
              trades={activeOverlay?.trades}
              plots={activeOverlay?.plots}
              strategyName={activeOverlay?.name}
              onClearStrategy={() => setOverlay(undefined)}
              strategies={chartStrategies}
              activeStrategyId={activeOverlay?.id}
              onAddStrategy={addStrategyToChart}
              focusTime={activeOverlay ? chartFocus : undefined}
              theme={theme}
              onNeedHistory={stream.loadOlder}
            />
          )}
          {mode === "trade" && (
            <Suspense fallback={<StrategyLoading />}>
              <TradingView strategies={strategyLibrary} catalog={catalog} />
            </Suspense>
          )}
          {mode === "strategy" && (
            <Suspense fallback={<StrategyLoading />}>
              <StrategyLab
                artifacts={strategyLibrary}
                activeArtifactId={activeArtifactId}
                onSelectArtifact={setActiveArtifactId}
                onCreateArtifact={createArtifact}
                onSaveArtifact={saveStrategyArtifact}
                catalog={catalog}
                initialSymbol={symbol}
                initialTimeframe={timeframe}
                theme={theme}
                onApplyResult={(result, btSymbol, btTimeframe) =>
                  setOverlay({
                    name: result.name,
                    signals: result.signals,
                    trades: result.trades,
                    symbol: btSymbol,
                    timeframe: btTimeframe
                  })
                }
                onShowOnChart={(btSymbol, btTimeframe) => {
                  setSymbol(btSymbol);
                  setTimeframe(btTimeframe);
                  setMode("chart");
                  // Focus the most recent signal / trade exit so it's on screen.
                  const times = [
                    ...(overlay?.signals ?? []).map((marker) => marker.time),
                    ...(overlay?.trades ?? []).map((trade) => trade.exitTime)
                  ];
                  setChartFocus(times.length ? Math.max(...times) : Date.now());
                }}
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

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <AlertToasts toasts={priceAlerts.toasts} decimalsFor={decimalsFor} onDismiss={priceAlerts.dismissToast} />
    </div>
  );
}

function readPanel(key: string, fallback: boolean) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writePanel(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function upsertArtifact(items: StrategyArtifact[], artifact: StrategyArtifact) {
  const existing = items.find((item) => item.id === artifact.id);
  if (!existing) return [artifact, ...items];
  return items.map((item) => (
    item.id === artifact.id
      ? { ...artifact, createdAt: item.createdAt, updatedAt: Date.now() }
      : item
  ));
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
