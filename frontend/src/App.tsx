import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { compareColor } from "./chart/compareColors";
import type { IndicatorConfig } from "./chart/indicatorTypes";
import type { ChartMarker, ChartPlot, ChartShapes, ChartTable, ChartTrade, CompareChartType, CompareOverlayConfig } from "./chart/types";
import { AlertToasts } from "./components/AlertToasts";
import { ChartCanvas } from "./components/ChartCanvas";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { StatsPanel } from "./components/StatsPanel";
import { TopBar } from "./components/TopBar";
import { Watchlist } from "./components/Watchlist";
import { useCatalog } from "./hooks/useCatalog";
import { loadLocale, storeLocale, type Locale } from "./i18n";
import { useCompareSeries } from "./hooks/useCompareSeries";
import { useMarketStream } from "./hooks/useMarketStream";
import { useLivePositions } from "./hooks/useLivePositions";
import { usePriceAlerts } from "./hooks/usePriceAlerts";
import { useSparklines } from "./hooks/useSparklines";
import type { StrategyArtifact, StrategyArtifactKind } from "./strategy/library";
import { createNewArtifact, indicatorArtifactId, indicatorToArtifact } from "./strategy/library";
import type { StrategyTemplate } from "./strategy/templates";
import type { Workspace } from "./workspace/workspaces";
import { applyIndicatorSelection, captureWorkspace, loadWorkspaces, saveWorkspaces } from "./workspace/workspaces";
import { loadStrategyLab, warmStrategyLab } from "./strategy/loadStrategyLab";
import { loadTradingView, warmTradingView } from "./trading/loadTradingView";
import { clearShareHash, readSharedFromHash } from "./strategy/share";
import { loadInitialWorkspaceState, storeIndicators, storeStrategyLibrary } from "./strategy/storage";
import type { AssetClass, ChartType, DataExchange, Instrument, Timeframe } from "./types";

const StrategyLab = lazy(loadStrategyLab);
const TradingView = lazy(loadTradingView);
const initialWorkspaceState = loadInitialWorkspaceState();

/** Max simultaneous compare-overlay symbols. */
const MAX_COMPARE = 3;
const DEFAULT_COMPARE_UP = "#23c97a";
const DEFAULT_COMPARE_DOWN = "#ef5350";
const ARTIFACT_INPUTS_KEY = "marketforge.artifactInputs.v1";

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
    shapes?: ChartShapes;
    tables?: ChartTable[];
    inputs?: { name: string; value: number }[];
    summary?: string;
    symbol: string;
    timeframe: Timeframe;
  }>();
  const [chartFocus, setChartFocus] = useState<number>();
  const [artifactInputOverrides, setArtifactInputOverrides] = useState<Record<string, Record<string, number>>>(() => readArtifactInputOverrides());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("mf:theme") === "light") ? "light" : "dark"
  );
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const [leftOpen, setLeftOpen] = useState(() => readPanel("mf:panel:left", true));
  const [rightOpen, setRightOpen] = useState(() => readPanel("mf:panel:right", true));
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => loadWorkspaces());
  const [compareOverlays, setCompareOverlays] = useState<CompareOverlayConfig[]>(() => loadCompare(timeframe, chartType));
  const stream = useMarketStream(symbol, timeframe, cryptoExchange);
  const compareState = useCompareSeries(compareOverlays, cryptoExchange);

  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

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
    try {
      localStorage.setItem("sbv2:compare", JSON.stringify(compareOverlays));
    } catch {
      // ignore storage failures
    }
  }, [compareOverlays]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mf:theme", theme);
    } catch {
      // ignore storage failures
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    storeLocale(locale);
  }, [locale]);

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

  useEffect(() => {
    try { localStorage.setItem(ARTIFACT_INPUTS_KEY, JSON.stringify(artifactInputOverrides)); } catch { /* runtime state still works */ }
  }, [artifactInputOverrides]);

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

  const addCompare = useCallback((sym: string) => {
    setCompareOverlays((current) =>
      current.some((item) => item.symbol === sym) || current.length >= MAX_COMPARE
        ? current
        : [
          ...current,
          {
            id: sym,
            symbol: sym,
            timeframe,
            chartType: asCompareChartType(chartType),
            color: compareColor(current.length),
            upColor: DEFAULT_COMPARE_UP,
            downColor: DEFAULT_COMPARE_DOWN
          }
        ]
    );
  }, [chartType, timeframe]);
  const updateCompare = useCallback((id: string, patch: Partial<CompareOverlayConfig>) => {
    setCompareOverlays((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch, chartType: asCompareChartType(patch.chartType ?? item.chartType) } : item))
    );
  }, []);
  const removeCompare = useCallback((id: string) => {
    setCompareOverlays((current) => current.filter((item) => item.id !== id));
  }, []);

  // Never compare the base symbol against itself — drop it if it becomes active.
  useEffect(() => {
    setCompareOverlays((current) =>
      current.some((item) => item.symbol === symbol) ? current.filter((item) => item.symbol !== symbol) : current
    );
  }, [symbol]);

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

  const chartCustomIndicators = useMemo(
    () => strategyLibrary
      .filter((item) => item.kind === "indicator" && !item.linkedIndicatorId)
      .map((item) => ({ id: item.id, name: item.name, description: item.description })),
    [strategyLibrary]
  );

  const chartStrategies = useMemo(
    () => strategyLibrary.filter((item) => item.kind === "strategy").map((item) => ({ id: item.id, name: item.name, description: item.description })),
    [strategyLibrary]
  );

  // Compile any saved custom indicator or strategy and overlay its chart visuals.
  const addArtifactToChart = async (id: string, explicitOverrides?: Record<string, number>) => {
    const artifact = strategyLibrary.find((item) => item.id === id);
    if (!artifact) return;
    const [{ compileXmlToIr }, backtest, { loadSecurityDataForIr }, cycles] = await Promise.all([
      import("./strategy/compileArtifact"),
      import("./strategy/backtest"),
      import("./strategy/securityLoader"),
      import("./strategy/pine/cyclesAnalysisPreview")
    ]);
    const compiled = compileXmlToIr(artifact.xml);
    if (!compiled.ir) return;
    const overrides = explicitOverrides ?? artifactInputOverrides[id] ?? {};
    const compatibleIr = cycles.withCyclesAnalysisInputs(compiled.ir);
    const ir = {
      ...compatibleIr,
      inputs: compatibleIr.inputs.map((input) => ({ ...input, value: overrides[input.name] ?? input.value }))
    };
    const securityData = await loadSecurityDataForIr(ir, {
      symbol,
      timeframe,
      chartCandles: stream.candles,
      exchange: cryptoExchange
    });
    // Show the strategy's plotted lines + every signal point, plus the trades it took.
    const preview = cycles.previewCyclesAnalysis(ir, stream.candles) ??
      backtest.previewStrategy(ir, stream.candles, securityData);
    const result = backtest.runBacktest(ir, stream.candles, backtest.DEFAULT_CONFIG, securityData);
    setOverlay({ id, name: artifact.name, plots: preview.plots, shapes: preview.shapes, tables: preview.tables, inputs: ir.inputs, signals: preview.signals, trades: result.trades, summary: "summary" in preview ? preview.summary : undefined, symbol, timeframe });
    const times = [...preview.signals.map((s) => s.time), ...result.trades.map((t) => t.exitTime)];
    setChartFocus(times.length ? Math.max(...times) : Date.now());
  };

  const updateActiveArtifactInput = (name: string, value: number) => {
    const id = activeOverlay?.id;
    if (!id) return;
    const next = { ...(artifactInputOverrides[id] ?? {}), [name]: value };
    setArtifactInputOverrides((current) => ({ ...current, [id]: next }));
    void addArtifactToChart(id, next);
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
    indicators.forEach((indicator) =>
      list.push({
        id: `ind-${indicator.id}`,
        group: "Indicator",
        label: `${indicator.enabled ? "Hide" : "Show"} ${indicator.label}`,
        run: () => {
          setIndicators((current) => current.map((item) => (item.id === indicator.id ? { ...item, enabled: !item.enabled } : item)));
          setMode("chart");
        }
      })
    );
    if (priceAlerts.alerts.length > 0) {
      list.push({
        id: "alerts-clear",
        group: "Alerts",
        label: `Clear all price alerts (${priceAlerts.alerts.length})`,
        run: () => priceAlerts.alerts.forEach((alert) => priceAlerts.removeAlert(alert.id))
      });
    }
    return list;
  }, [catalog, indicators, priceAlerts.alerts, priceAlerts.removeAlert]);

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
    let saved: StrategyArtifact = artifact;
    setStrategyLibrary((current) => {
      const next = upsertArtifact(current, artifact);
      saved = next.find((item) => item.id === artifact.id) ?? artifact;
      return next;
    });
    if (!artifact.linkedIndicatorId) return;
    setIndicators((current) => current.map((indicator) => (
      indicator.id === artifact.linkedIndicatorId
        ? { ...indicator, logicCode: saved.code, logicXml: saved.xml, logicVersion: saved.version, logicHash: saved.hash }
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

  // Instantiate a gallery template as a fresh, editable copy (never mutating the
  // read-only template) and select it.
  const useTemplate = (template: StrategyTemplate) => {
    const now = Date.now();
    const artifact: StrategyArtifact = {
      id: `strategy:tpl-copy-${now}`,
      kind: "strategy",
      name: dedupeName(template.name, strategyLibrary),
      description: template.description,
      xml: template.xml,
      code: "",
      createdAt: now,
      updatedAt: now
    };
    setStrategyLibrary((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

  // Add one or more converted Pine scripts as new editable artifacts in a single
  // pass — Pine indicator() → indicator artifact, strategy() → strategy artifact —
  // deduping names against the library AND within the batch, then selecting the first.
  const importPineMany = (
    inputs: { kind: "indicator" | "strategy"; name: string; xml: string; code: string; warnings: string[] }[]
  ) => {
    if (!inputs.length) return;
    const now = Date.now();
    const firstId = `${inputs[0].kind}:pine-${now}-0`;
    setStrategyLibrary((current) => {
      const taken = new Set(current.map((item) => item.name));
      const dedupe = (name: string) => {
        if (!taken.has(name)) return name;
        let n = 2;
        while (taken.has(`${name} (${n})`)) n += 1;
        return `${name} (${n})`;
      };
      const created: StrategyArtifact[] = inputs.map((input, i) => {
        const name = dedupe(input.name);
        taken.add(name);
        return {
          id: `${input.kind}:pine-${now}-${i}`,
          kind: input.kind,
          name,
          description: `Imported from Pine Script${input.warnings.length ? ` (${input.warnings.length} fidelity warning${input.warnings.length === 1 ? "" : "s"})` : ""}.`,
          xml: input.xml,
          code: input.code,
          createdAt: now,
          updatedAt: now
        };
      });
      return [...created, ...current];
    });
    setActiveArtifactId(firstId);
    warmStrategyLab();
  };

  const importStrategy = (input: { name: string; description: string; xml: string }) => {
    const now = Date.now();
    const artifact: StrategyArtifact = {
      id: `strategy:import-${now}`,
      kind: "strategy",
      name: dedupeName(input.name, strategyLibrary),
      description: input.description || "Imported strategy.",
      xml: input.xml,
      code: "",
      createdAt: now,
      updatedAt: now
    };
    setStrategyLibrary((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

  // --- Saved workspaces (named chart layouts) ---
  const saveWorkspace = (name: string) => {
    const workspace = captureWorkspace(name, { symbol, timeframe, chartType, cryptoExchange, indicators, theme });
    setWorkspaces((current) => [workspace, ...current]);
  };

  const applyWorkspace = (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    setSymbol(workspace.symbol);
    setTimeframe(workspace.timeframe);
    setChartType(workspace.chartType);
    setCryptoExchange(workspace.cryptoExchange);
    setTheme(workspace.theme);
    setIndicators((current) => applyIndicatorSelection(current, workspace.enabledIndicators));
    setMode("chart");
  };

  const deleteWorkspace = (id: string) => {
    setWorkspaces((current) => current.filter((item) => item.id !== id));
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
        locale={locale}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        workspaces={workspaces}
        onSaveWorkspace={saveWorkspace}
        onApplyWorkspace={applyWorkspace}
        onDeleteWorkspace={deleteWorkspace}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onModeChange={setMode}
        onStrategyWarmup={warmStrategyLab}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        onToggleLocale={() => setLocale((current) => (current === "en" ? "ru" : "en"))}
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
              shapes={activeOverlay?.shapes}
              tables={activeOverlay?.tables}
              alerts={priceAlerts.alerts}
              onAddAlert={(price) =>
                priceAlerts.addAlert({
                  symbol: instrument.symbol,
                  price,
                  direction: price >= (stream.candles.at(-1)?.close ?? price) ? "above" : "below"
                })
              }
              livePositions={livePositions}
              strategyName={activeOverlay?.name}
              strategySummary={activeOverlay?.summary}
              strategyInputs={activeOverlay?.inputs}
              onStrategyInputChange={updateActiveArtifactInput}
              onClearStrategy={() => setOverlay(undefined)}
              customIndicators={chartCustomIndicators}
              strategies={chartStrategies}
              activeArtifactId={activeOverlay?.id}
              onAddArtifact={addArtifactToChart}
              focusTime={activeOverlay ? chartFocus : undefined}
              theme={theme}
              onNeedHistory={stream.loadOlder}
              compareSeries={compareState.series}
              compareLoading={compareState.loading}
              compareErrors={compareState.errors}
              compareOverlays={compareOverlays}
              compareCandidates={compareCandidates}
              compareTimeframes={catalog?.timeframes ?? []}
              compareChartTypes={catalog?.chartTypes ?? []}
              onAddCompare={addCompare}
              onUpdateCompare={updateCompare}
              onRemoveCompare={removeCompare}
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
                onUseTemplate={useTemplate}
                onImportStrategy={importStrategy}
                onImportPineMany={importPineMany}
                catalog={catalog}
                initialSymbol={symbol}
                initialTimeframe={timeframe}
                exchange={cryptoExchange}
                theme={theme}
                onApplyResult={(result, btSymbol, btTimeframe, visuals) =>
                  setOverlay({
                    name: result.name,
                    signals: result.signals,
                    trades: result.trades,
                    plots: visuals?.plots,
                    shapes: visuals?.shapes,
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

/** Load persisted compare overlays, tolerating the old string[] storage shape. */
function loadCompare(defaultTimeframe: Timeframe, defaultChartType: ChartType): CompareOverlayConfig[] {
  try {
    const raw = window.localStorage.getItem("sbv2:compare");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index): CompareOverlayConfig | undefined => {
        if (typeof item === "string") {
          return {
            id: item,
            symbol: item,
            timeframe: defaultTimeframe,
            chartType: asCompareChartType(defaultChartType),
            color: compareColor(index),
            upColor: DEFAULT_COMPARE_UP,
            downColor: DEFAULT_COMPARE_DOWN
          };
        }
        if (!item || typeof item !== "object") return undefined;
        const candidate = item as Partial<CompareOverlayConfig>;
        if (typeof candidate.symbol !== "string") return undefined;
        return {
          id: typeof candidate.id === "string" ? candidate.id : candidate.symbol,
          symbol: candidate.symbol,
          timeframe: asTimeframe(candidate.timeframe, defaultTimeframe),
          chartType: asCompareChartType(candidate.chartType ?? defaultChartType),
          color: typeof candidate.color === "string" ? candidate.color : compareColor(index),
          upColor: typeof candidate.upColor === "string" ? candidate.upColor : DEFAULT_COMPARE_UP,
          downColor: typeof candidate.downColor === "string" ? candidate.downColor : DEFAULT_COMPARE_DOWN
        };
      })
      .filter((item): item is CompareOverlayConfig => Boolean(item))
      .slice(0, MAX_COMPARE);
  } catch {
    return [];
  }
}

function asTimeframe(value: unknown, fallback: Timeframe): Timeframe {
  const allowed: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
  return typeof value === "string" && allowed.includes(value as Timeframe) ? value as Timeframe : fallback;
}

function asCompareChartType(value: unknown): CompareChartType {
  const allowed: CompareChartType[] = ["candles", "heikin", "bars", "line", "area", "baseline"];
  return typeof value === "string" && allowed.includes(value as CompareChartType) ? value as CompareChartType : "line";
}

/** Append " (n)" until the name is unique within the library. */
function dedupeName(name: string, items: StrategyArtifact[]): string {
  const taken = new Set(items.map((item) => item.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

function readArtifactInputOverrides(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem(ARTIFACT_INPUTS_KEY);
    return raw ? JSON.parse(raw) as Record<string, Record<string, number>> : {};
  } catch {
    return {};
  }
}

function upsertArtifact(items: StrategyArtifact[], artifact: StrategyArtifact) {
  const existing = items.find((item) => item.id === artifact.id);
  const stamped = stampArtifact(artifact, existing);
  if (!existing) return [stamped, ...items];
  return items.map((item) => (
    item.id === artifact.id
      ? { ...stamped, createdAt: item.createdAt, updatedAt: Date.now() }
      : item
  ));
}

function stampArtifact(artifact: StrategyArtifact, existing?: StrategyArtifact): StrategyArtifact {
  const hash = artifactHash(artifact);
  const unchanged = existing?.hash === hash;
  return {
    ...artifact,
    hash,
    version: unchanged ? existing?.version ?? artifact.version ?? 1 : (existing?.version ?? 0) + 1
  };
}

function artifactHash(artifact: Pick<StrategyArtifact, "kind" | "name" | "xml" | "code">): string {
  const text = `${artifact.kind}\n${artifact.name}\n${artifact.xml}\n${artifact.code ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
