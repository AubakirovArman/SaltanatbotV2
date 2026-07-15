import { AlertTriangle, Code2, FileJson, Loader2, Play, Save, Share2, Workflow } from "lucide-react";
import type { PortfolioBacktestConfig, PortfolioBacktestResult } from "@saltanatbotv2/backtest-core";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { BacktestConfig, BacktestResult } from "../backtest";
import { blockInspectorDoc } from "../blockCatalog";
import type { StrategyArtifact } from "../library";
import type { StrategyIR } from "../ir";
import type { OptimizeResult, WalkForwardResult } from "../optimizer";
import type { GeneticOptimizeResult, GeneticProgress } from "../geneticOptimizer";
import type { OptSpecState } from "../optimization/model";
import type { CatalogResponse, Timeframe } from "../../types";
import { BacktestReport } from "../../components/BacktestReport";
import { PortfolioBacktestReport } from "../../components/PortfolioBacktestReport";
import { localeTag, type Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import { OptimizePanel } from "./OptimizePanel";
import { ArtifactVersionPanel } from "./ArtifactVersionPanel";
import type { CompileDiagnostic } from "../compile";
import { PortfolioControls } from "./PortfolioControls";

const BAR_CHOICES = [500, 1000, 3000, 5000, 10000, 20000, 50000];

const COST_PRESETS: { id: string; labelKey: "majorsTaker" | "altcoin" | "custom"; commissionPct: number; slippagePct: number }[] = [
  { id: "majors", labelKey: "majorsTaker", commissionPct: 0.04, slippagePct: 0.02 },
  { id: "altcoin", labelKey: "altcoin", commissionPct: 0.075, slippagePct: 0.08 },
  { id: "custom", labelKey: "custom", commissionPct: Number.NaN, slippagePct: Number.NaN }
];

interface StrategyExecutionPanelProps {
  locale: Locale;
  activeArtifact?: StrategyArtifact;
  artifacts: StrategyArtifact[];
  onRollbackArtifact: (version: number) => void;
  onDependenciesChange: (dependencies: string[]) => void;
  selectedType?: string;
  running: boolean;
  optimizing: boolean;
  onRun: () => void;
  onToggleOptimize: () => void;
  onShare: () => void;
  onSave: () => void;
  shareState: "idle" | "copied";
  strategyInputs: StrategyIR["inputs"];
  optOpen: boolean;
  catalog?: CatalogResponse;
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  bars: number;
  onBarsChange: (bars: number) => void;
  config: BacktestConfig;
  onConfigChange: Dispatch<SetStateAction<BacktestConfig>>;
  portfolioEnabled: boolean;
  onPortfolioEnabledChange: (enabled: boolean) => void;
  portfolioSymbols: string[];
  onPortfolioSymbolsChange: Dispatch<SetStateAction<string[]>>;
  portfolioConfig: PortfolioBacktestConfig;
  onPortfolioConfigChange: Dispatch<SetStateAction<PortfolioBacktestConfig>>;
  optSpec: OptSpecState | null;
  onOptSpecChange: Dispatch<SetStateAction<OptSpecState | null>>;
  onOptimize: () => void;
  onCancelOptimize: () => void;
  optProgress: { done: number; total: number };
  walkForwardOn: boolean;
  onToggleWalkForward: (enabled: boolean) => void;
  optFolds: number;
  onFoldsChange: (folds: number) => void;
  walkForwardMode: "rolling" | "anchored";
  onWalkForwardModeChange: (mode: "rolling" | "anchored") => void;
  optimizeResult?: OptimizeResult;
  optimizationMode: "grid" | "genetic";
  onOptimizationModeChange: (mode: "grid" | "genetic") => void;
  geneticConfig: { populationSize: number; generations: number; mutationRate: number; seed: number };
  onGeneticConfigChange: (config: { populationSize: number; generations: number; mutationRate: number; seed: number }) => void;
  geneticResult?: GeneticOptimizeResult;
  geneticProgress?: GeneticProgress;
  walkForwardResult?: WalkForwardResult;
  onApplyCombo: (params: Record<string, number>) => void;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  onDiagnosticSelect: (blockId?: string) => void;
  result?: BacktestResult;
  portfolioResult?: PortfolioBacktestResult;
  decimals: number;
  onShowOnChart?: () => void;
  onOpenTrading?: () => void;
  jsonSize: number;
  preview: string;
  savedAt?: number;
}

type StudioStage = "build" | "validate" | "preview" | "backtest" | "optimize" | "run" | "learn";
const studioStages: Array<{ id: StudioStage; key: "stageBuild" | "stageValidate" | "stagePreview" | "stageBacktest" | "stageOptimize" | "stageRun" | "stageLearn" }> = [
  { id: "build", key: "stageBuild" },
  { id: "validate", key: "stageValidate" },
  { id: "preview", key: "stagePreview" },
  { id: "backtest", key: "stageBacktest" },
  { id: "optimize", key: "stageOptimize" },
  { id: "run", key: "stageRun" },
  { id: "learn", key: "stageLearn" }
];

export function StrategyExecutionPanel(props: StrategyExecutionPanelProps) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(props.locale, key);
  const help = props.selectedType ? blockInspectorDoc(props.selectedType) : undefined;
  const [stage, setStage] = useState<StudioStage>("build");
  const selectStage = (next: StudioStage) => {
    setStage(next);
    if (next === "optimize" && !props.optOpen && props.strategyInputs.length > 0) props.onToggleOptimize();
  };
  return (
    <aside className="code-preview">
      <div className="lab-breadcrumb">
        <Workflow size={13} aria-hidden="true" />
        <strong>{props.activeArtifact?.name ?? t("strategyLab")}</strong>
        <span>{props.activeArtifact ? `${props.activeArtifact.kind} v${props.activeArtifact.version ?? 1}` : ""}</span>
      </div>
      {props.activeArtifact && <ArtifactVersionPanel locale={props.locale} artifact={props.activeArtifact} artifacts={props.artifacts} onRollback={props.onRollbackArtifact} onDependenciesChange={props.onDependenciesChange} />}
      <nav className="studio-stage-tabs" aria-label={t("studioStages")}>
        {studioStages.map((item) => (
          <button type="button" key={item.id} className={stage === item.id ? "active" : ""} aria-pressed={stage === item.id} onClick={() => selectStage(item.id)}>
            {t(item.key)}
          </button>
        ))}
      </nav>
      <div className="backtest-controls studio-global-actions">
        <button type="button" onClick={props.onShare} title={t("copyShareLink")} className={props.shareState === "copied" ? "shared" : ""}>
          <Share2 size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={props.onSave} disabled={!props.activeArtifact} title={t("save")}>
          <Save size={15} aria-hidden="true" />
        </button>
      </div>
      {props.shareState === "copied" && <div className="share-toast">{t("shareCopied")}</div>}

      {stage === "build" && (
        <section className="studio-stage-panel">
          <div className="panel-header">
            <strong>{t("parameterSchema")}</strong>
            <span>{props.strategyInputs.length}</span>
          </div>
          {props.strategyInputs.length === 0 ? (
            <p>{t("noNumericInputs")}</p>
          ) : (
            <table className="studio-parameter-table">
              <thead>
                <tr>
                  <th>{t("inputs")}</th>
                  <th>{t("default")}</th>
                  <th>{t("min")}</th>
                  <th>{t("max")}</th>
                  <th>{t("step")}</th>
                  <th>{t("optimizer")}</th>
                </tr>
              </thead>
              <tbody>
                {props.strategyInputs.map((input) => (
                  <tr key={input.name}>
                    <th scope="row">{input.name}</th>
                    <td>{input.defaultValue ?? input.value}</td>
                    <td>{input.min ?? "—"}</td>
                    <td>{input.max ?? "—"}</td>
                    <td>{input.step ?? "—"}</td>
                    <td>{input.optimizationEligible === false ? t("disabled") : t("enabled")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p>{t("functionsHint")}</p>
        </section>
      )}

      {stage === "validate" && (
        <section className="studio-stage-panel">
          <div className="panel-header">
            <strong>{t("validation")}</strong>
            <span>{props.diagnostics.length}</span>
          </div>
          {props.diagnostics.length > 0 ? (
            <div className="strategy-warnings" role="status">
              {props.diagnostics.map((diagnostic, index) =>
                diagnostic.blockId ? (
                  <button type="button" key={`${diagnostic.message}-${index}`} onClick={() => props.onDiagnosticSelect(diagnostic.blockId)}>
                    <AlertTriangle size={12} aria-hidden="true" /> {diagnostic.message} <code>{diagnostic.blockType}</code>
                  </button>
                ) : (
                  <span key={`${diagnostic.message}-${index}`}>
                    <AlertTriangle size={12} aria-hidden="true" /> {diagnostic.message}
                  </span>
                )
              )}
            </div>
          ) : (
            <p role="status">{t("validationPassed")}</p>
          )}
        </section>
      )}

      {stage === "preview" && (
        <section className="studio-stage-panel">
          <div className="panel-header">
            <strong>
              <Code2 size={15} aria-hidden="true" /> {t("preview")}
            </strong>
            <span>
              {props.jsonSize} {t("bytes")}
            </span>
          </div>
          <pre>{props.preview || t("connectBlocks")}</pre>
        </section>
      )}

      {stage === "backtest" && (
        <section className="studio-stage-panel">
          <form
            className="strategy-backtest-form"
            onSubmit={(event) => {
              event.preventDefault();
              props.onRun();
            }}
          >
            <div className="backtest-controls">
              <button type="submit" className="run-button" disabled={props.running || props.optimizing}>
                {props.running ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                {props.running ? t("loadingHistory") : t("runBacktest")}
              </button>
            </div>
            <MarketControls {...props} />
            <PortfolioControls
              locale={props.locale}
              enabled={props.portfolioEnabled}
              onEnabledChange={props.onPortfolioEnabledChange}
              primarySymbol={props.symbol}
              symbols={props.portfolioSymbols}
              onSymbolsChange={props.onPortfolioSymbolsChange}
              catalog={props.catalog}
              config={props.portfolioConfig}
              onConfigChange={props.onPortfolioConfigChange}
            />
          </form>
          {props.errors.length > 0 && (
            <div className="strategy-warnings" role="alert">
              {props.errors.map((message) => (
                <span key={message}>
                  <AlertTriangle size={12} aria-hidden="true" />
                  {message}
                </span>
              ))}
            </div>
          )}
          {props.portfolioResult ? <PortfolioBacktestReport locale={props.locale} result={props.portfolioResult} /> : props.result ? <BacktestReport locale={props.locale} result={props.result} decimals={props.decimals} config={props.config} onShowOnChart={props.onShowOnChart} /> : <p>{t("runBacktestHint")}</p>}
        </section>
      )}

      {stage === "optimize" && (
        <section className="studio-stage-panel">
          {props.strategyInputs.length === 0 && <div className="opt-hint">{t("noNumericInputs")}</div>}
          <MarketControls {...props} />
          {props.optOpen && props.optSpec && (
            <OptimizePanel
              locale={props.locale}
              spec={props.optSpec}
              inputs={props.strategyInputs}
              onSpecChange={props.onOptSpecChange}
              onRun={props.onOptimize}
              onCancel={props.onCancelOptimize}
              optimizing={props.optimizing}
              progress={props.optProgress}
              mode={props.optimizationMode}
              onModeChange={props.onOptimizationModeChange}
              geneticConfig={props.geneticConfig}
              onGeneticConfigChange={props.onGeneticConfigChange}
              geneticResult={props.geneticResult}
              geneticProgress={props.geneticProgress}
              walkForwardOn={props.walkForwardOn}
              onToggleWalkForward={props.onToggleWalkForward}
              folds={props.optFolds}
              onFoldsChange={props.onFoldsChange}
              walkForwardMode={props.walkForwardMode}
              onWalkForwardModeChange={props.onWalkForwardModeChange}
              result={props.optimizeResult}
              walkForwardResult={props.walkForwardResult}
              onApplyCombo={props.onApplyCombo}
              decimals={props.decimals}
            />
          )}
        </section>
      )}

      {stage === "run" && (
        <section className="studio-stage-panel studio-run-stage">
          <strong>{t("runReadiness")}</strong>
          <p>{props.diagnostics.length ? t("fixValidationBeforeRun") : t("runReadinessHint")}</p>
          {props.onShowOnChart && (
            <button type="button" onClick={props.onShowOnChart}>
              {t("showOnChart")}
            </button>
          )}
          {props.onOpenTrading && (
            <button type="button" disabled={props.diagnostics.length > 0} onClick={props.onOpenTrading}>
              {t("openExperimentalTrading")}
            </button>
          )}
        </section>
      )}

      {stage === "learn" &&
        (help ? (
          <div className="block-help" style={{ padding: "8px 10px", margin: "0 0 8px", borderRadius: 8, background: "rgba(134,150,166,0.10)", fontSize: 12, lineHeight: 1.45 }}>
            <strong>{help.title}</strong>
            <div style={{ opacity: 0.85, marginTop: 3 }}>{help.body}</div>
            <dl className="block-inspector-contract">
              <div>
                <dt>{t("inputs")}</dt>
                <dd>{help.inputs.join(" · ")}</dd>
              </div>
              <div>
                <dt>{t("output")}</dt>
                <dd>{help.output}</dd>
              </div>
              <div>
                <dt>{t("example")}</dt>
                <dd>
                  <code>{help.example}</code>
                </dd>
              </div>
              <div>
                <dt>{t("pitfalls")}</dt>
                <dd>{help.pitfalls.join(" · ")}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="studio-stage-panel">{t("selectBlockToLearn")}</p>
        ))}

      <div className="ir-note">
        <FileJson size={15} aria-hidden="true" />
        {props.savedAt ? `${t("autosaved")} ${new Date(props.savedAt).toLocaleTimeString(localeTag(props.locale), { hour: "2-digit", minute: "2-digit" })}` : t("changesAutosave")}
      </div>
    </aside>
  );
}

function MarketControls(props: StrategyExecutionPanelProps) {
  const setConfig = props.onConfigChange;
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(props.locale, key);
  return (
    <fieldset className="backtest-settings">
      <legend>{t("backtestSettings")}</legend>
      <div className="config-row">
        <label>
          {t("market")}
          <select name="backtest-market" value={props.symbol} onChange={(event) => props.onSymbolChange(event.target.value)}>
            {(props.catalog?.instruments ?? []).map((item) => (
              <option key={item.symbol} value={item.symbol}>
                {item.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("interval")}
          <select name="backtest-timeframe" value={props.timeframe} onChange={(event) => props.onTimeframeChange(event.target.value as Timeframe)}>
            {(props.catalog?.timeframes ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("bars")}
          <select name="backtest-bars" value={props.bars} onChange={(event) => props.onBarsChange(Number(event.target.value))}>
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
          {t("capital")}
          <input name="backtest-capital" type="number" value={props.config.initialCapital} min={100} step={100} onChange={(event) => setConfig((current) => ({ ...current, initialCapital: Number(event.target.value) || 0 }))} />
        </label>
        <label>
          {t("costPreset")}
          <select name="backtest-cost-preset" value={matchPreset(props.config.commissionPct, props.config.slippagePct ?? 0)} onChange={(event) => applyPreset(event.target.value, setConfig)}>
            {COST_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(preset.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input name="backtest-shorts" type="checkbox" checked={props.config.allowShort} onChange={(event) => setConfig((current) => ({ ...current, allowShort: event.target.checked }))} />
          {t("shorts")}
        </label>
      </div>
      <div className="config-row">
        <label>
          {t("fee")}
          <input name="backtest-fee" type="number" value={props.config.commissionPct} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, commissionPct: Number(event.target.value) || 0 }))} />
        </label>
        <label>
          {t("slippage")}
          <input name="backtest-slippage" type="number" value={props.config.slippagePct ?? 0} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, slippagePct: Number(event.target.value) || 0 }))} />
        </label>
        <label title={t("fundingHelp")}>
          {t("funding")}
          <input name="backtest-funding" type="number" value={props.config.fundingRatePctPer8h ?? 0} step={0.001} onChange={(event) => setConfig((current) => ({ ...current, fundingRatePctPer8h: Number(event.target.value) || 0 }))} />
        </label>
        <label>
          {t("fills")}
          <select name="backtest-fills" value={props.config.fillTiming ?? "next_open"} onChange={(event) => setConfig((current) => ({ ...current, fillTiming: event.target.value as "next_open" | "same_close" }))}>
            <option value="next_open">{t("nextOpen")}</option>
            <option value="same_close">{t("sameClose")}</option>
          </select>
        </label>
      </div>
    </fieldset>
  );
}

function matchPreset(commissionPct: number, slippagePct: number): string {
  return COST_PRESETS.find((preset) => preset.commissionPct === commissionPct && preset.slippagePct === slippagePct)?.id ?? "custom";
}

function applyPreset(id: string, setConfig: Dispatch<SetStateAction<BacktestConfig>>) {
  const preset = COST_PRESETS.find((item) => item.id === id);
  if (!preset || preset.id === "custom") return;
  setConfig((current) => ({ ...current, commissionPct: preset.commissionPct, slippagePct: preset.slippagePct }));
}
