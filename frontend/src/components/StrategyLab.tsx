import { AlertTriangle, Code2, Download, FileJson, LayoutGrid, Loader2, Play, Plus, Save, Share2, SlidersHorizontal, Upload, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { getCandles } from "../api/marketClient";
import { registerStrategyBlocks, strategyToolbox } from "../strategy/blocks";
import { compileWorkspace } from "../strategy/compile";
import { buildShareUrl } from "../strategy/share";
import { irToText } from "../strategy/irText";
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig, type BacktestResult } from "../strategy/backtest";
import { cloneWithInputs, type Objective, type OptimizeResult, type OptimizeSpec, type ParamSpec, type WalkForwardResult } from "../strategy/optimizer";
import { runOptimizeInWorker, runWalkForwardInWorker } from "../strategy/optimizerClient";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import { strategyTemplates, type StrategyTemplate, type TemplateCategory } from "../strategy/templates";
import { downloadStrategyFile, parseStrategyFile } from "../strategy/strategyFile";
import type { StrategyIR } from "../strategy/ir";
import type { Candle, CatalogResponse, Timeframe } from "../types";
import { BacktestReport } from "./BacktestReport";

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
  catalog?: CatalogResponse;
  initialSymbol: string;
  initialTimeframe: Timeframe;
  theme?: "dark" | "light";
  onApplyResult?: (result: BacktestResult, symbol: string, timeframe: Timeframe) => void;
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

const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "netProfit", label: "Net profit" },
  { id: "sharpe", label: "Sharpe" },
  { id: "profitFactor", label: "Profit factor" },
  { id: "returnOverDd", label: "Return / MaxDD" }
];

/** How a single swept input is edited in the UI (enabled + range). */
interface AxisState {
  name: string;
  enabled: boolean;
  min: number;
  max: number;
  step: number;
}

interface OptSpecState {
  objective: Objective;
  trainFrac: number;
  axes: AxisState[];
}

/** Seed an editable sweep spec from a strategy's inputs (up to 3 pre-enabled). */
function initOptSpec(ir: StrategyIR): OptSpecState {
  const axes: AxisState[] = ir.inputs.map((input, i) => {
    const base = input.value;
    // Default a sensible symmetric range around the current value.
    const span = Math.max(Math.abs(base) * 0.5, base === 0 ? 5 : 1);
    const step = niceStep(span);
    return {
      name: input.name,
      enabled: i < 1, // enable the first input by default
      min: round4(base - span),
      max: round4(base + span),
      step
    };
  });
  return { objective: "netProfit", trainFrac: 0.7, axes };
}

function niceStep(span: number): number {
  const raw = span / 5;
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return round4(nice * mag);
}

function round4(v: number): number {
  return Number.parseFloat(v.toFixed(4));
}

/** Translate the editable spec into the pure OptimizeSpec the core consumes. */
function buildSpec(state: OptSpecState): OptimizeSpec {
  const params: ParamSpec[] = state.axes
    .filter((axis) => axis.enabled)
    .slice(0, 3)
    .map((axis) => ({ name: axis.name, min: axis.min, max: axis.max, step: axis.step > 0 ? axis.step : 1 }));
  return { params, objective: state.objective, trainFrac: state.trainFrac };
}

/** Count the grid combos an editable spec would enumerate (for the UI hint). */
function comboCount(state: OptSpecState): number {
  let total = 1;
  for (const axis of state.axes) {
    if (!axis.enabled) continue;
    const step = axis.step > 0 ? axis.step : 1;
    const n = axis.max >= axis.min ? Math.floor((axis.max - axis.min) / step + 1e-9) + 1 : 1;
    total *= Math.max(1, n);
  }
  return total;
}

export function StrategyLab({ artifacts, activeArtifactId, onSelectArtifact, onCreateArtifact, onSaveArtifact, onUseTemplate, onImportStrategy, catalog, initialSymbol, initialTimeframe, theme = "dark", onApplyResult, onShowOnChart }: StrategyLabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const previewRef = useRef<() => void>(() => undefined);
  const autosaveTimer = useRef<number>();
  const previewTimer = useRef<number>();
  const onSaveRef = useRef(onSaveArtifact);
  const activeRef = useRef<StrategyArtifact>();

  const [preview, setPreview] = useState("");
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
    let candles = (await getCandles(btSymbol, btTimeframe, chunk)).candles;
    while (candles.length < btBars && candles.length > 0) {
      const oldest = candles[0].time;
      const older = (await getCandles(btSymbol, btTimeframe, 1000, oldest - 1)).candles.filter((candle) => candle.time < oldest);
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
      const backtest = runBacktest(compiled.ir, candles, config);
      setResult(backtest);
      setOptimizeResult(undefined);
      onApplyResult?.(backtest, btSymbol, btTimeframe);
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
      const onProgress = (done: number, total: number) => setOptProgress({ done, total });
      if (walkForwardOn) {
        const wf = await runWalkForwardInWorker(compiled.ir, candles, config, spec, { folds: optFolds }, onProgress);
        setWalkForwardResult(wf);
      }
      const opt = await runOptimizeInWorker(compiled.ir, candles, config, spec, onProgress);
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
    const backtest = runBacktest(cloned, candles, config);
    setResult(backtest);
    setOptimizeResult(undefined);
    onApplyResult?.(backtest, btSymbol, btTimeframe);
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
        <StrategyLibrary artifacts={artifacts} activeId={activeArtifact?.id} onSelect={onSelectArtifact} onCreate={onCreateArtifact} onUseTemplate={onUseTemplate} onImportStrategy={onImportStrategy} />
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
            <span>{activeArtifact?.kind ?? ""}</span>
          </div>
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

const MAX_COMBOS = 2000;

function OptimizePanel({
  spec,
  inputs,
  onSpecChange,
  onRun,
  optimizing,
  progress,
  walkForwardOn,
  onToggleWalkForward,
  folds,
  onFoldsChange,
  result,
  walkForwardResult,
  onApplyCombo,
  decimals
}: {
  spec: OptSpecState;
  inputs: StrategyIR["inputs"];
  onSpecChange: (spec: OptSpecState) => void;
  onRun: () => void;
  optimizing: boolean;
  progress: { done: number; total: number };
  walkForwardOn: boolean;
  onToggleWalkForward: (on: boolean) => void;
  folds: number;
  onFoldsChange: (n: number) => void;
  result?: OptimizeResult;
  walkForwardResult?: WalkForwardResult;
  onApplyCombo: (params: Record<string, number>) => void;
  decimals: number;
}) {
  const enabledCount = spec.axes.filter((axis) => axis.enabled).length;
  const combos = comboCount(spec);
  const pct = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  const patchAxis = (name: string, patch: Partial<AxisState>) => {
    onSpecChange({
      ...spec,
      axes: spec.axes.map((axis) => {
        if (axis.name !== name) return axis;
        // Enforce the 1–3 sweep cap when enabling a new axis.
        if (patch.enabled && !axis.enabled && enabledCount >= 3) return axis;
        return { ...axis, ...patch };
      })
    });
  };

  return (
    <div className="optimizer">
      <div className="panel-header small">
        <strong>
          <SlidersHorizontal size={13} aria-hidden="true" /> Optimizer
        </strong>
        <span>{combos > MAX_COMBOS ? `${MAX_COMBOS}+ combos` : `${combos} combo${combos === 1 ? "" : "s"}`}</span>
      </div>

      <div className="opt-axes">
        {inputs.map((input) => {
          const axis = spec.axes.find((a) => a.name === input.name);
          if (!axis) return null;
          const disabled = !axis.enabled && enabledCount >= 3;
          return (
            <div key={input.name} className={axis.enabled ? "opt-axis on" : "opt-axis"}>
              <label className="opt-axis-toggle" title={disabled ? "Up to 3 parameters at once" : undefined}>
                <input type="checkbox" checked={axis.enabled} disabled={disabled} onChange={(event) => patchAxis(input.name, { enabled: event.target.checked })} />
                <span className="opt-axis-name">{input.name}</span>
                <span className="opt-axis-cur">= {input.value}</span>
              </label>
              {axis.enabled && (
                <div className="opt-axis-range">
                  <label>
                    min
                    <input type="number" value={axis.min} onChange={(event) => patchAxis(input.name, { min: Number(event.target.value) })} />
                  </label>
                  <label>
                    max
                    <input type="number" value={axis.max} onChange={(event) => patchAxis(input.name, { max: Number(event.target.value) })} />
                  </label>
                  <label>
                    step
                    <input type="number" value={axis.step} min={0} onChange={(event) => patchAxis(input.name, { step: Number(event.target.value) })} />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="config-row">
        <label>
          Objective
          <select value={spec.objective} onChange={(event) => onSpecChange({ ...spec, objective: event.target.value as Objective })}>
            {OBJECTIVES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Train %
          <input type="number" value={Math.round(spec.trainFrac * 100)} min={20} max={90} step={5} onChange={(event) => onSpecChange({ ...spec, trainFrac: clamp01((Number(event.target.value) || 70) / 100) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={walkForwardOn} onChange={(event) => onToggleWalkForward(event.target.checked)} />
          Walk-fwd
        </label>
        {walkForwardOn && (
          <label>
            Folds
            <input type="number" value={folds} min={2} max={12} step={1} onChange={(event) => onFoldsChange(Math.max(2, Math.min(12, Number(event.target.value) || 4)))} />
          </label>
        )}
      </div>

      {combos > MAX_COMBOS && (
        <div className="opt-hint">
          Grid has {combos.toLocaleString()} combos — only the first {MAX_COMBOS.toLocaleString()} will be evaluated. Widen the step to shrink the grid.
        </div>
      )}

      <button type="button" className="run-button" onClick={onRun} disabled={optimizing || enabledCount === 0}>
        {optimizing ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <SlidersHorizontal size={15} aria-hidden="true" />}
        {optimizing ? (progress.total ? `Optimizing… ${progress.done}/${progress.total}` : "Optimizing…") : "Run optimizer"}
      </button>

      {optimizing && (
        <div className="opt-progress">
          <div className="opt-progress-bar" style={{ inlineSize: `${pct}%` }} />
        </div>
      )}

      {result && !optimizing && <OptimizeResults result={result} onApplyCombo={onApplyCombo} />}
      {walkForwardOn && walkForwardResult && !optimizing && <WalkForwardResults wf={walkForwardResult} decimals={decimals} />}
    </div>
  );
}

function OptimizeResults({ result, onApplyCombo }: { result: OptimizeResult; onApplyCombo: (params: Record<string, number>) => void }) {
  const rows = result.ranked.slice(0, 20);
  const keys = result.ranked[0] ? Object.keys(result.ranked[0].params) : [];
  return (
    <div className="opt-results">
      <div className="panel-header small">
        <strong>Ranked · {objectiveLabel(result.objective)}</strong>
        <span>
          {result.evaluated}/{result.totalCombos}
          {result.truncated ? " (capped)" : ""}
        </span>
      </div>
      <div className="opt-table" role="table">
        <div className="opt-row head" role="row">
          <span>{keys.join(" · ") || "params"}</span>
          <span title="In-sample objective score">IS</span>
          <span title="Out-of-sample objective score">OOS</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="opt-row" role="row" key={i}>
            <span className="opt-params">{keys.map((k) => row.params[k]).join(" · ")}</span>
            <span className="opt-score">{fmtScore(row.score)}</span>
            <span className={`opt-score ${row.outScore === undefined ? "" : row.outScore >= 0 ? "up" : "down"}`}>{row.outScore === undefined ? "—" : fmtScore(row.outScore)}</span>
            <button type="button" className="link-button" onClick={() => onApplyCombo(row.params)}>
              Apply
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function WalkForwardResults({ wf, decimals }: { wf: WalkForwardResult; decimals: number }) {
  if (wf.folds.length === 0) {
    return <div className="opt-hint">Not enough history to build walk-forward folds. Increase bars or reduce folds.</div>;
  }
  const agg = wf.aggregate;
  const keys = Object.keys(wf.folds[0].params);
  return (
    <div className="opt-results">
      <div className="panel-header small">
        <strong>Walk-forward · {wf.folds.length} folds</strong>
        {agg && (
          <span className={agg.netProfit >= 0 ? "up" : "down"}>
            OOS {agg.netProfit >= 0 ? "+" : ""}
            {agg.netProfit.toFixed(2)}
          </span>
        )}
      </div>
      <div className="opt-table wf" role="table">
        <div className="opt-row head" role="row">
          <span>#</span>
          <span>{keys.join(" · ") || "params"}</span>
          <span title="Out-of-sample net profit">OOS net</span>
          <span title="Out-of-sample trades">Trades</span>
          <span title="Out-of-sample win rate">Win%</span>
        </div>
        {wf.folds.map((fold) => (
          <div className="opt-row" role="row" key={fold.fold}>
            <span>{fold.fold + 1}</span>
            <span className="opt-params">{keys.map((k) => fold.params[k]).join(" · ")}</span>
            <span className={fold.outSample.netProfit >= 0 ? "up" : "down"}>
              {fold.outSample.netProfit >= 0 ? "+" : ""}
              {fold.outSample.netProfit.toFixed(2)}
            </span>
            <span>{fold.outSample.totalTrades}</span>
            <span>{fold.outSample.winRate.toFixed(0)}%</span>
          </div>
        ))}
      </div>
      {agg && (
        <div className="assumptions">
          <span>OOS trades {agg.totalTrades}</span>
          <span>Win {agg.winRate.toFixed(0)}%</span>
          <span>PF {Number.isFinite(agg.profitFactor) ? agg.profitFactor.toFixed(2) : "∞"}</span>
          <span>Max DD {agg.maxDrawdownPct.toFixed(1)}%</span>
          <span title="Final stitched OOS equity">Final {agg.finalEquity.toFixed(decimals === 0 ? 0 : 2)}</span>
        </div>
      )}
    </div>
  );
}

function objectiveLabel(objective: Objective): string {
  return OBJECTIVES.find((o) => o.id === objective)?.label ?? objective;
}

function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function clamp01(v: number): number {
  return Math.min(0.95, Math.max(0.05, v));
}

function StrategyLibrary({
  artifacts,
  activeId,
  onSelect,
  onCreate,
  onUseTemplate,
  onImportStrategy
}: {
  artifacts: StrategyArtifact[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: (kind: StrategyArtifactKind) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: { name: string; description: string; xml: string }) => void;
}) {
  const indicators = artifacts.filter((artifact) => artifact.kind === "indicator");
  const strategies = artifacts.filter((artifact) => artifact.kind === "strategy");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [importError, setImportError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const importFile = async (file: File) => {
    setImportError(undefined);
    try {
      const parsed = parseStrategyFile(await file.text());
      if (!parsed) {
        setImportError("Not a valid .strategy file.");
        return;
      }
      onImportStrategy({ name: parsed.name, description: parsed.description, xml: parsed.xml });
    } catch {
      setImportError("Could not read that file.");
    }
  };

  return (
    <aside className="strategy-library">
      <div className="strategy-library-actions">
        <button type="button" onClick={() => onCreate("indicator")}>
          <Plus size={14} aria-hidden="true" /> Indicator
        </button>
        <button type="button" onClick={() => onCreate("strategy")}>
          <Plus size={14} aria-hidden="true" /> Strategy
        </button>
        <button type="button" onClick={() => setGalleryOpen(true)} title="Browse ready-made strategy templates">
          <LayoutGrid size={14} aria-hidden="true" /> Gallery
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} title="Import a .strategy file">
          <Upload size={14} aria-hidden="true" /> Import
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".strategy,.json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      {importError && (
        <div className="import-error" role="alert">
          {importError}
        </div>
      )}
      <LibraryGroup title="Indicators" items={indicators} activeId={activeId} onSelect={onSelect} />
      <LibraryGroup title="Strategies" items={strategies} activeId={activeId} onSelect={onSelect} />
      {galleryOpen && (
        <TemplateGallery
          onClose={() => setGalleryOpen(false)}
          onUse={(template) => {
            onUseTemplate(template);
            setGalleryOpen(false);
          }}
        />
      )}
    </aside>
  );
}

function LibraryGroup({
  title,
  items,
  activeId,
  onSelect
}: {
  title: string;
  items: StrategyArtifact[];
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="library-group">
      <div className="panel-header">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      <div className="library-items">
        {items.map((item) => (
          <div key={item.id} className={`library-item ${item.id === activeId ? "active" : ""}`}>
            <button type="button" className="library-item-main" onClick={() => onSelect(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.description}</span>
            </button>
            <button
              type="button"
              className="library-item-export"
              title="Export as .strategy file"
              aria-label={`Export ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                downloadStrategyFile(item);
              }}
            >
              <Download size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Trend", "Mean reversion", "Breakout", "Momentum"];

function TemplateGallery({
  onClose,
  onUse
}: {
  onClose: () => void;
  onUse: (template: StrategyTemplate) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const categories = TEMPLATE_CATEGORIES.map((category) => ({
    category,
    items: strategyTemplates.filter((template) => template.category === category)
  })).filter((group) => group.items.length > 0);

  return (
    <div className="gallery-backdrop" role="dialog" aria-modal="true" aria-label="Strategy template gallery" onClick={onClose}>
      <div className="gallery-modal" onClick={(event) => event.stopPropagation()}>
        <div className="gallery-head">
          <strong>
            <LayoutGrid size={15} aria-hidden="true" /> Strategy Gallery
          </strong>
          <button type="button" className="icon-button" onClick={onClose} title="Close" aria-label="Close gallery">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="gallery-body">
          {categories.map((group) => (
            <section key={group.category} className="gallery-group">
              <div className="panel-header">
                <strong>{group.category}</strong>
                <span>{group.items.length}</span>
              </div>
              <div className="gallery-cards">
                {group.items.map((template) => (
                  <article key={template.id} className="gallery-card">
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                    <div className="gallery-tags">
                      {template.tags.map((tag) => (
                        <span key={tag} className="gallery-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <button type="button" className="gallery-use" onClick={() => onUse(template)}>
                      Use
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
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
