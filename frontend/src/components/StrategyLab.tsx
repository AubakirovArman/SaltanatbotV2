import { AlertTriangle, Code2, FileJson, Loader2, Play, Plus, Save, Share2, SlidersHorizontal, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { getCandles } from "../api/marketClient";
import { registerStrategyBlocks, strategyToolbox } from "../strategy/blocks";
import { blockCatalog } from "../strategy/blockCatalog";
import type { PineImport } from "../strategy/pine";
import { compileWorkspace } from "../strategy/compile";
import { buildShareUrl } from "../strategy/share";
import { irToText } from "../strategy/irText";
import { DEFAULT_CONFIG, runBacktest, previewStrategy, type BacktestConfig, type BacktestResult, type PlotSeries, type ShapeOverlays } from "../strategy/backtest";
import { cloneWithInputs, type OptimizeResult, type WalkForwardResult } from "../strategy/optimizer";
import { runOptimizeInWorker, runWalkForwardInWorker } from "../strategy/optimizerClient";
import { loadSecurityDataForIr } from "../strategy/securityLoader";
import type { SecurityDataContext } from "../strategy/securityData";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import type { StrategyTemplate } from "../strategy/templates";
import type { StrategyIR } from "../strategy/ir";
import type { Candle, CatalogResponse, DataExchange, Timeframe } from "../types";
import { BacktestReport } from "./BacktestReport";
import { StrategyLibrary } from "../strategy/components/StrategyLibrary";
import { OptimizePanel } from "../strategy/components/OptimizePanel";
import { buildSpec, initOptSpec, type OptSpecState } from "../strategy/optimization/model";

const blocklyMessages = Object.fromEntries(Object.entries(En).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
let localeReady = false;

const blocklyFont = {
  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  weight: "500",
  size: 11
};

const forgeDark = Blockly.Theme.defineTheme("forge-dark", {
  name: "forge-dark",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#0e1116",
    toolboxBackgroundColour: "#10141a",
    toolboxForegroundColour: "#9aa7b3",
    flyoutBackgroundColour: "#151a21",
    flyoutForegroundColour: "#9aa7b3",
    flyoutOpacity: 0.97,
    scrollbarColour: "#222933",
    scrollbarOpacity: 0.45,
    insertionMarkerColour: "#4db6ff",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#4db6ff"
  },
  fontStyle: blocklyFont
});

const forgeLight = Blockly.Theme.defineTheme("forge-light", {
  name: "forge-light",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#f7f9fb",
    toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#5f6d7a",
    flyoutBackgroundColour: "#eef1f5",
    flyoutForegroundColour: "#5f6d7a",
    flyoutOpacity: 0.97,
    scrollbarColour: "#c9d2db",
    scrollbarOpacity: 0.55,
    insertionMarkerColour: "#1273c4",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#1273c4"
  },
  fontStyle: blocklyFont
});

interface StrategyLabProps {
  artifacts: StrategyArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onCreateArtifact: (kind: StrategyArtifactKind) => void;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  /** Instantiate a gallery template as a new editable copy and select it. */
  onUseTemplate: (template: StrategyTemplate) => void;
  /** Import a validated `.strategy` file as a new editable artifact and select it. */
  onImportStrategy: (input: { name: string; description: string; xml: string }) => void;
  /** Import one or more converted Pine Scripts (paste + uploaded files) as new
   *  editable artifacts, selecting the first. */
  onImportPineMany: (inputs: PineImport[]) => void;
  catalog?: CatalogResponse;
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange?: DataExchange;
  theme?: "dark" | "light";
  onApplyResult?: (
    result: BacktestResult,
    symbol: string,
    timeframe: Timeframe,
    visuals?: { plots: PlotSeries[]; shapes: ShapeOverlays }
  ) => void;
  onShowOnChart?: (symbol: string, timeframe: Timeframe) => void;
}

const BAR_CHOICES = [500, 1000, 3000, 5000, 10000, 20000, 50000];

/** Cost presets set commission + slippage together to match a venue/instrument tier. */
const COST_PRESETS: { id: string; label: string; commissionPct: number; slippagePct: number }[] = [
  { id: "majors", label: "Majors / taker", commissionPct: 0.04, slippagePct: 0.02 },
  { id: "altcoin", label: "Altcoin", commissionPct: 0.075, slippagePct: 0.08 },
  { id: "custom", label: "Custom", commissionPct: NaN, slippagePct: NaN }
];

function matchPreset(commissionPct: number, slippagePct: number): string {
  const hit = COST_PRESETS.find((p) => p.commissionPct === commissionPct && p.slippagePct === slippagePct);
  return hit ? hit.id : "custom";
}

export function StrategyLab({ artifacts, activeArtifactId, onSelectArtifact, onCreateArtifact, onSaveArtifact, onUseTemplate, onImportStrategy, onImportPineMany, catalog, initialSymbol, initialTimeframe, exchange = "binance", theme = "dark", onApplyResult, onShowOnChart }: StrategyLabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const previewRef = useRef<() => void>(() => undefined);
  const autosaveTimer = useRef<number>();
  const previewTimer = useRef<number>();
  const onSaveRef = useRef(onSaveArtifact);
  const activeRef = useRef<StrategyArtifact>();

  const [preview, setPreview] = useState("");
  const [selectedType, setSelectedType] = useState<string>();
  const [strategyInputs, setStrategyInputs] = useState<StrategyIR["inputs"]>([]);
  const [jsonSize, setJsonSize] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [initError, setInitError] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  const [result, setResult] = useState<BacktestResult>();
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [btSymbol, setBtSymbol] = useState(initialSymbol);
  const [btTimeframe, setBtTimeframe] = useState<Timeframe>(initialTimeframe);
  const [btBars, setBtBars] = useState(1000);
  const [running, setRunning] = useState(false);

  // Optimizer state.
  const [optOpen, setOptOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [optSpec, setOptSpec] = useState<OptSpecState | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult>();
  const [walkForwardOn, setWalkForwardOn] = useState(false);
  const [optFolds, setOptFolds] = useState(4);
  const [walkForwardResult, setWalkForwardResult] = useState<WalkForwardResult>();
  const optCandlesRef = useRef<Candle[]>([]);
  const optIrRef = useRef<StrategyIR>();
  const optSecurityRef = useRef<SecurityDataContext>({});

  const btInstrument = catalog?.instruments.find((item) => item.symbol === btSymbol);
  const decimals = btInstrument?.decimals ?? 2;

  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts[0];
  onSaveRef.current = onSaveArtifact;
  activeRef.current = activeArtifact;

  useEffect(() => {
    if (!localeReady) {
      Blockly.setLocale(blocklyMessages);
      localeReady = true;
    }
    registerStrategyBlocks();

    const container = containerRef.current;
    if (!container) return;

    let workspace: Blockly.WorkspaceSvg;
    let observer: ResizeObserver | undefined;
    try {
      workspace = Blockly.inject(container, {
        toolbox: strategyToolbox,
        media: "/blockly-media/",
        trashcan: false,
        theme: document.documentElement.dataset.theme === "light" ? forgeLight : forgeDark,
        renderer: "thrasos",
        sounds: false,
        move: { scrollbars: true, drag: true, wheel: true },
        zoom: { controls: false, wheel: true, startScale: 0.7, maxScale: 1.25, minScale: 0.42 },
        grid: { spacing: 24, length: 2, colour: "rgba(134, 150, 166, 0.10)", snap: true }
      });
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : "Blockly failed to start");
      return;
    }

    workspaceRef.current = workspace;

    const doPreview = () => {
      const compiled = compileWorkspace(workspace);
      setPreview(compiled.ir ? irToText(compiled.ir) : "");
      setStrategyInputs(compiled.ir ? compiled.ir.inputs : []);
      setErrors(compiled.errors);
      setJsonSize(JSON.stringify(Blockly.serialization.workspaces.save(workspace)).length);
    };
    previewRef.current = doPreview;

    const autosave = () => {
      const art = activeRef.current;
      if (!art) return;
      const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
      const compiled = compileWorkspace(workspace);
      onSaveRef.current({
        ...art,
        name: extractWorkspaceName(workspace) || art.name,
        xml,
        code: compiled.ir ? irToText(compiled.ir) : "",
        updatedAt: Date.now()
      });
      setSavedAt(Date.now());
    };

    const onChange = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const id = (event as Blockly.Events.Selected).newElementId;
        const block = id ? workspace.getBlockById(id) : null;
        setSelectedType(block?.type ?? undefined);
      }
      if (event.isUiEvent) return;
      window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(doPreview, 250);
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = window.setTimeout(autosave, 700);
    };

    doPreview();
    workspace.addChangeListener(onChange);
    observer = new ResizeObserver(() => Blockly.svgResize(workspace));
    observer.observe(container);
    requestAnimationFrame(() => fitWorkspaceView(workspace));

    return () => {
      window.clearTimeout(previewTimer.current);
      window.clearTimeout(autosaveTimer.current);
      workspace.removeChangeListener(onChange);
      observer?.disconnect();
      workspace.dispose();
      workspaceRef.current = null;
      previewRef.current = () => undefined;
    };
  }, []);

  // Keep the Blockly theme in sync with the app theme.
  useEffect(() => {
    workspaceRef.current?.setTheme(theme === "light" ? forgeLight : forgeDark);
  }, [theme]);

  // (Re)seed the optimizer sweep spec whenever the SET of numeric inputs changes
  // (added/removed/renamed) — not on every value tweak, so edited ranges stick.
  const inputKey = strategyInputs.map((input) => input.name).join("|");
  useEffect(() => {
    if (strategyInputs.length === 0) {
      setOptSpec(null);
      return;
    }
    setOptSpec(initOptSpec({ name: "", inputs: strategyInputs, body: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  // Load the active artifact into the workspace when the selection changes.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !activeArtifact) return;
    try {
      workspace.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(activeArtifact.xml), workspace);
      setInitError(undefined);
      setSavedAt(undefined);
      setResult(undefined);
      requestAnimationFrame(() => {
        fitWorkspaceView(workspace);
        previewRef.current();
      });
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : "Selected logic failed to load");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArtifact?.id]);

  const saveNow = () => {
    const workspace = workspaceRef.current;
    if (!workspace || !activeArtifact) return;
    const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    const compiled = compileWorkspace(workspace);
    onSaveArtifact({
      ...activeArtifact,
      name: extractWorkspaceName(workspace) || activeArtifact.name,
      xml,
      code: compiled.ir ? irToText(compiled.ir) : "",
      updatedAt: Date.now()
    });
    setSavedAt(Date.now());
  };

  // Fetch `btBars` of history for the selected market/interval, paging back as
  // needed. Shared by the plain backtest and the optimizer so both run on the
  // exact same candle window.
  const fetchHistory = async (): Promise<Candle[]> => {
    const chunk = Math.min(btBars, 1000);
    let candles = (await getCandles(btSymbol, btTimeframe, chunk, undefined, exchange)).candles;
    while (candles.length < btBars && candles.length > 0) {
      const oldest = candles[0].time;
      const older = (await getCandles(btSymbol, btTimeframe, 1000, oldest - 1, exchange)).candles.filter((candle) => candle.time < oldest);
      if (older.length === 0) break;
      candles = [...older, ...candles];
    }
    return candles.slice(-btBars);
  };

  const runNow = async () => {
    const workspace = workspaceRef.current;
    if (!workspace || running) return;
    const compiled = compileWorkspace(workspace);
    // Refuse to backtest a strategy with compile errors — the IR may be missing
    // dropped blocks, so its results would be misleading.
    if (!compiled.ir || compiled.errors.length) {
      setErrors(compiled.errors.length ? compiled.errors : ["Nothing to run."]);
      setResult(undefined);
      return;
    }
    setErrors([]);
    setRunning(true);
    try {
      const candles = await fetchHistory();
      if (candles.length < 30) {
        setErrors([...compiled.errors, "Not enough history for this market/interval."]);
        return;
      }
      const securityData = await loadSecurityDataForIr(compiled.ir, {
        symbol: btSymbol,
        timeframe: btTimeframe,
        chartCandles: candles,
        exchange
      });
      const backtest = runBacktest(compiled.ir, candles, config, securityData);
      setResult(backtest);
      setOptimizeResult(undefined);
      const visuals = previewStrategy(compiled.ir, candles, securityData);
      onApplyResult?.(backtest, btSymbol, btTimeframe, { plots: visuals.plots, shapes: visuals.shapes });
    } catch (cause) {
      setErrors([...compiled.errors, cause instanceof Error ? cause.message : "History request failed."]);
    } finally {
      setRunning(false);
    }
  };

  // Run the parameter optimizer (grid + OOS, optionally walk-forward) in a
  // worker, then render either the ranked table or a normal backtest of the
  // combo the user clicked.
  const optimizeNow = async () => {
    const workspace = workspaceRef.current;
    if (!workspace || running || optimizing) return;
    const compiled = compileWorkspace(workspace);
    if (!compiled.ir || compiled.errors.length || compiled.ir.inputs.length === 0 || !optSpec) {
      setErrors(compiled.errors.length ? compiled.errors : ["This strategy has no numeric inputs to optimize."]);
      return;
    }
    const spec = buildSpec(optSpec);
    if (spec.params.length === 0) {
      setErrors([...compiled.errors, "Pick at least one input to sweep."]);
      return;
    }
    setErrors(compiled.errors);
    setOptimizing(true);
    setOptProgress({ done: 0, total: 0 });
    setResult(undefined);
    setOptimizeResult(undefined);
    setWalkForwardResult(undefined);
    try {
      const candles = await fetchHistory();
      if (candles.length < 60) {
        setErrors([...compiled.errors, "Need at least 60 bars to split into in-sample / out-of-sample."]);
        return;
      }
      optCandlesRef.current = candles;
      optIrRef.current = compiled.ir;
      const securityData = await loadSecurityDataForIr(compiled.ir, {
        symbol: btSymbol,
        timeframe: btTimeframe,
        chartCandles: candles,
        exchange
      });
      optSecurityRef.current = securityData;
      const onProgress = (done: number, total: number) => setOptProgress({ done, total });
      if (walkForwardOn) {
        const wf = await runWalkForwardInWorker(compiled.ir, candles, config, spec, { folds: optFolds }, onProgress, securityData);
        setWalkForwardResult(wf);
      }
      const opt = await runOptimizeInWorker(compiled.ir, candles, config, spec, onProgress, securityData);
      setOptimizeResult(opt);
    } catch (cause) {
      setErrors([...compiled.errors, cause instanceof Error ? cause.message : "Optimization failed."]);
    } finally {
      setOptimizing(false);
    }
  };

  // Re-run a full backtest on the whole window with a chosen combo's params and
  // show it via the normal BacktestReport.
  const applyCombo = (params: Record<string, number>) => {
    const ir = optIrRef.current;
    const candles = optCandlesRef.current;
    if (!ir || !candles.length) return;
    const cloned = cloneWithInputs(ir, params);
    const securityData = optSecurityRef.current;
    const backtest = runBacktest(cloned, candles, config, securityData);
    setResult(backtest);
    setOptimizeResult(undefined);
    const visuals = previewStrategy(cloned, candles, securityData);
    onApplyResult?.(backtest, btSymbol, btTimeframe, { plots: visuals.plots, shapes: visuals.shapes });
  };

  const shareNow = () => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    const name = extractWorkspaceName(workspace) || activeArtifact?.name || "Strategy";
    const url = buildShareUrl({ name, xml });
    const done = () => {
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2200);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
    else done();
  };

  return (
    <section className="strategy-lab">
      <div className="strategy-grid">
        <StrategyLibrary artifacts={artifacts} activeId={activeArtifact?.id} onSelect={onSelectArtifact} onCreate={onCreateArtifact} onUseTemplate={onUseTemplate} onImportStrategy={onImportStrategy} onImportPineMany={onImportPineMany} />
        <div className="blockly-shell">
          <div className="blockly-host" ref={containerRef} />
          {initError && (
            <div className="strategy-error" role="alert">
              <strong>Strategy editor did not start</strong>
              <span>{initError}</span>
            </div>
          )}
        </div>
        <aside className="code-preview">
          <div className="lab-breadcrumb">
            <Workflow size={13} aria-hidden="true" />
            <strong>{activeArtifact?.name ?? "Strategy Lab"}</strong>
            <span>{activeArtifact ? `${activeArtifact.kind} v${activeArtifact.version ?? 1}` : ""}</span>
          </div>
          {selectedType && blockCatalog[selectedType] && (
            <div className="block-help" style={{ padding: "8px 10px", margin: "0 0 8px", borderRadius: 8, background: "rgba(134,150,166,0.10)", fontSize: 12, lineHeight: 1.45 }}>
              <strong>{blockCatalog[selectedType].title}</strong>
              <div style={{ opacity: 0.85, marginTop: 3 }}>{blockCatalog[selectedType].body}</div>
              {blockCatalog[selectedType].example && (
                <code style={{ display: "block", marginTop: 4, opacity: 0.75 }}>e.g. {blockCatalog[selectedType].example}</code>
              )}
            </div>
          )}
          <div className="backtest-controls">
            <button type="button" className="run-button" onClick={runNow} disabled={running || optimizing}>
              {running ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              {running ? "Loading history…" : "Run backtest"}
            </button>
            <button type="button" onClick={() => setOptOpen((v) => !v)} disabled={strategyInputs.length === 0} className={optOpen ? "shared" : ""} title={strategyInputs.length === 0 ? "Add a numeric input block to enable optimization" : "Optimize parameters"}>
              <SlidersHorizontal size={15} aria-hidden="true" />
            </button>
            <button type="button" onClick={shareNow} title="Copy share link" className={shareState === "copied" ? "shared" : ""}>
              <Share2 size={15} aria-hidden="true" />
            </button>
            <button type="button" onClick={saveNow} disabled={!activeArtifact} title="Save">
              <Save size={15} aria-hidden="true" />
            </button>
          </div>
          {strategyInputs.length === 0 && optOpen && <div className="opt-hint">This strategy has no numeric inputs to optimize. Add an input block first.</div>}
          {shareState === "copied" && <div className="share-toast">Share link copied to clipboard</div>}
          <div className="config-row">
            <label>
              Market
              <select value={btSymbol} onChange={(event) => setBtSymbol(event.target.value)}>
                {(catalog?.instruments ?? []).map((item) => (
                  <option key={item.symbol} value={item.symbol}>
                    {item.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Interval
              <select value={btTimeframe} onChange={(event) => setBtTimeframe(event.target.value as Timeframe)}>
                {(catalog?.timeframes ?? []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bars
              <select value={btBars} onChange={(event) => setBtBars(Number(event.target.value))}>
                {BAR_CHOICES.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="config-row">
            <label>
              Capital
              <input type="number" value={config.initialCapital} min={100} step={100} onChange={(event) => setConfig((current) => ({ ...current, initialCapital: Number(event.target.value) || 0 }))} />
            </label>
            <label>
              Cost preset
              <select
                value={matchPreset(config.commissionPct, config.slippagePct ?? 0)}
                onChange={(event) => {
                  const preset = COST_PRESETS.find((p) => p.id === event.target.value);
                  if (!preset || preset.id === "custom") return;
                  setConfig((current) => ({ ...current, commissionPct: preset.commissionPct, slippagePct: preset.slippagePct }));
                }}
              >
                {COST_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={config.allowShort} onChange={(event) => setConfig((current) => ({ ...current, allowShort: event.target.checked }))} />
              Shorts
            </label>
          </div>
          <div className="config-row">
            <label>
              Fee %
              <input type="number" value={config.commissionPct} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, commissionPct: Number(event.target.value) || 0 }))} />
            </label>
            <label>
              Slippage %
              <input type="number" value={config.slippagePct ?? 0} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, slippagePct: Number(event.target.value) || 0 }))} />
            </label>
            <label title="Perp funding / borrow cost per 8h a position is held (pro-rated to each bar)">
              Funding %/8h
              <input type="number" value={config.fundingRatePctPer8h ?? 0} step={0.001} onChange={(event) => setConfig((current) => ({ ...current, fundingRatePctPer8h: Number(event.target.value) || 0 }))} />
            </label>
            <label>
              Fills
              <select value={config.fillTiming ?? "next_open"} onChange={(event) => setConfig((current) => ({ ...current, fillTiming: event.target.value as "next_open" | "same_close" }))}>
                <option value="next_open">Next open</option>
                <option value="same_close">Same close</option>
              </select>
            </label>
          </div>

          {optOpen && optSpec && (
            <OptimizePanel
              spec={optSpec}
              inputs={strategyInputs}
              onSpecChange={setOptSpec}
              onRun={optimizeNow}
              optimizing={optimizing}
              progress={optProgress}
              walkForwardOn={walkForwardOn}
              onToggleWalkForward={setWalkForwardOn}
              folds={optFolds}
              onFoldsChange={setOptFolds}
              result={optimizeResult}
              walkForwardResult={walkForwardResult}
              onApplyCombo={applyCombo}
              decimals={decimals}
            />
          )}

          {errors.length > 0 && (
            <div className="strategy-warnings" role="status">
              {errors.map((message, index) => (
                <span key={index}>
                  <AlertTriangle size={12} aria-hidden="true" /> {message}
                </span>
              ))}
            </div>
          )}

          {result ? (
            <BacktestReport result={result} decimals={decimals} config={config} onShowOnChart={onShowOnChart ? () => onShowOnChart(btSymbol, btTimeframe) : undefined} />
          ) : (
            <>
              <div className="panel-header">
                <strong>
                  <Code2 size={15} aria-hidden="true" /> Preview
                </strong>
                <span>{jsonSize} bytes</span>
              </div>
              <pre>{preview || "Connect blocks to compile a strategy."}</pre>
            </>
          )}

          <div className="ir-note">
            <FileJson size={15} aria-hidden="true" />
            {savedAt ? `Autosaved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Changes autosave locally."}
          </div>
        </aside>
      </div>
    </section>
  );
}

function extractWorkspaceName(workspace: Blockly.WorkspaceSvg) {
  const root = workspace.getTopBlocks(false).find((block) => block.type === "strategy_start");
  return root?.getFieldValue("NAME") as string | undefined;
}

function fitWorkspaceView(workspace: Blockly.WorkspaceSvg) {
  Blockly.svgResize(workspace);
  requestAnimationFrame(() => {
    workspace.zoomToFit();
    workspace.scrollCenter();
  });
}
