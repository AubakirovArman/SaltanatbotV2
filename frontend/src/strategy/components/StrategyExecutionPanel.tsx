import { AlertTriangle, Code2, FileJson, Loader2, Play, Save, Share2, SlidersHorizontal, Workflow } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { BacktestConfig, BacktestResult } from "../backtest";
import { blockCatalog } from "../blockCatalog";
import type { StrategyArtifact } from "../library";
import type { StrategyIR } from "../ir";
import type { OptimizeResult, WalkForwardResult } from "../optimizer";
import type { OptSpecState } from "../optimization/model";
import type { CatalogResponse, Timeframe } from "../../types";
import { BacktestReport } from "../../components/BacktestReport";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import { OptimizePanel } from "./OptimizePanel";

const BAR_CHOICES = [500, 1000, 3000, 5000, 10000, 20000, 50000];

const COST_PRESETS: { id: string; labelKey: "majorsTaker" | "altcoin" | "custom"; commissionPct: number; slippagePct: number }[] = [
  { id: "majors", labelKey: "majorsTaker", commissionPct: 0.04, slippagePct: 0.02 },
  { id: "altcoin", labelKey: "altcoin", commissionPct: 0.075, slippagePct: 0.08 },
  { id: "custom", labelKey: "custom", commissionPct: Number.NaN, slippagePct: Number.NaN }
];

interface StrategyExecutionPanelProps {
  locale: Locale;
  activeArtifact?: StrategyArtifact;
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
  optSpec: OptSpecState | null;
  onOptSpecChange: Dispatch<SetStateAction<OptSpecState | null>>;
  onOptimize: () => void;
  optProgress: { done: number; total: number };
  walkForwardOn: boolean;
  onToggleWalkForward: (enabled: boolean) => void;
  optFolds: number;
  onFoldsChange: (folds: number) => void;
  optimizeResult?: OptimizeResult;
  walkForwardResult?: WalkForwardResult;
  onApplyCombo: (params: Record<string, number>) => void;
  errors: string[];
  result?: BacktestResult;
  decimals: number;
  onShowOnChart?: () => void;
  jsonSize: number;
  preview: string;
  savedAt?: number;
}

export function StrategyExecutionPanel(props: StrategyExecutionPanelProps) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(props.locale, key);
  const help = props.selectedType ? blockCatalog[props.selectedType] : undefined;
  return (
    <aside className="code-preview">
      <div className="lab-breadcrumb">
        <Workflow size={13} aria-hidden="true" />
        <strong>{props.activeArtifact?.name ?? t("strategyLab")}</strong>
        <span>{props.activeArtifact ? `${props.activeArtifact.kind} v${props.activeArtifact.version ?? 1}` : ""}</span>
      </div>
      {help && (
        <div className="block-help" style={{ padding: "8px 10px", margin: "0 0 8px", borderRadius: 8, background: "rgba(134,150,166,0.10)", fontSize: 12, lineHeight: 1.45 }}>
          <strong>{help.title}</strong>
          <div style={{ opacity: 0.85, marginTop: 3 }}>{help.body}</div>
          {help.example && <code style={{ display: "block", marginTop: 4, opacity: 0.75 }}>{t("example")} {help.example}</code>}
        </div>
      )}
      <div className="backtest-controls">
        <button type="button" className="run-button" onClick={props.onRun} disabled={props.running || props.optimizing}>
          {props.running ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {props.running ? t("loadingHistory") : t("runBacktest")}
        </button>
        <button type="button" onClick={props.onToggleOptimize} disabled={props.strategyInputs.length === 0} className={props.optOpen ? "shared" : ""} title={props.strategyInputs.length === 0 ? t("addNumericInput") : t("optimizeParameters")}>
          <SlidersHorizontal size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={props.onShare} title={t("copyShareLink")} className={props.shareState === "copied" ? "shared" : ""}><Share2 size={15} aria-hidden="true" /></button>
        <button type="button" onClick={props.onSave} disabled={!props.activeArtifact} title={t("save")}><Save size={15} aria-hidden="true" /></button>
      </div>
      {props.strategyInputs.length === 0 && props.optOpen && <div className="opt-hint">{t("noNumericInputs")}</div>}
      {props.shareState === "copied" && <div className="share-toast">{t("shareCopied")}</div>}
      <MarketControls {...props} />

      {props.optOpen && props.optSpec && (
        <OptimizePanel
          locale={props.locale}
          spec={props.optSpec}
          inputs={props.strategyInputs}
          onSpecChange={props.onOptSpecChange}
          onRun={props.onOptimize}
          optimizing={props.optimizing}
          progress={props.optProgress}
          walkForwardOn={props.walkForwardOn}
          onToggleWalkForward={props.onToggleWalkForward}
          folds={props.optFolds}
          onFoldsChange={props.onFoldsChange}
          result={props.optimizeResult}
          walkForwardResult={props.walkForwardResult}
          onApplyCombo={props.onApplyCombo}
          decimals={props.decimals}
        />
      )}

      {props.errors.length > 0 && (
        <div className="strategy-warnings" role="status">
          {props.errors.map((message, index) => <span key={`${message}-${index}`}><AlertTriangle size={12} aria-hidden="true" /> {message}</span>)}
        </div>
      )}

      {props.result ? (
        <BacktestReport locale={props.locale} result={props.result} decimals={props.decimals} config={props.config} onShowOnChart={props.onShowOnChart} />
      ) : (
        <>
          <div className="panel-header"><strong><Code2 size={15} aria-hidden="true" /> {t("preview")}</strong><span>{props.jsonSize} {t("bytes")}</span></div>
          <pre>{props.preview || t("connectBlocks")}</pre>
        </>
      )}

      <div className="ir-note">
        <FileJson size={15} aria-hidden="true" />
        {props.savedAt ? `${t("autosaved")} ${new Date(props.savedAt).toLocaleTimeString(props.locale === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" })}` : t("changesAutosave")}
      </div>
    </aside>
  );
}

function MarketControls(props: StrategyExecutionPanelProps) {
  const setConfig = props.onConfigChange;
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(props.locale, key);
  return (
    <>
      <div className="config-row">
        <label>{t("market")}<select value={props.symbol} onChange={(event) => props.onSymbolChange(event.target.value)}>{(props.catalog?.instruments ?? []).map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}</select></label>
        <label>{t("interval")}<select value={props.timeframe} onChange={(event) => props.onTimeframeChange(event.target.value as Timeframe)}>{(props.catalog?.timeframes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{t("bars")}<select value={props.bars} onChange={(event) => props.onBarsChange(Number(event.target.value))}>{BAR_CHOICES.map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
      </div>
      <div className="config-row">
        <label>{t("capital")}<input type="number" value={props.config.initialCapital} min={100} step={100} onChange={(event) => setConfig((current) => ({ ...current, initialCapital: Number(event.target.value) || 0 }))} /></label>
        <label>{t("costPreset")}<select value={matchPreset(props.config.commissionPct, props.config.slippagePct ?? 0)} onChange={(event) => applyPreset(event.target.value, setConfig)}>{COST_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{t(preset.labelKey)}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={props.config.allowShort} onChange={(event) => setConfig((current) => ({ ...current, allowShort: event.target.checked }))} />{t("shorts")}</label>
      </div>
      <div className="config-row">
        <label>{t("fee")}<input type="number" value={props.config.commissionPct} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, commissionPct: Number(event.target.value) || 0 }))} /></label>
        <label>{t("slippage")}<input type="number" value={props.config.slippagePct ?? 0} min={0} step={0.01} onChange={(event) => setConfig((current) => ({ ...current, slippagePct: Number(event.target.value) || 0 }))} /></label>
        <label title={t("fundingHelp")}>{t("funding")}<input type="number" value={props.config.fundingRatePctPer8h ?? 0} step={0.001} onChange={(event) => setConfig((current) => ({ ...current, fundingRatePctPer8h: Number(event.target.value) || 0 }))} /></label>
        <label>{t("fills")}<select value={props.config.fillTiming ?? "next_open"} onChange={(event) => setConfig((current) => ({ ...current, fillTiming: event.target.value as "next_open" | "same_close" }))}><option value="next_open">{t("nextOpen")}</option><option value="same_close">{t("sameClose")}</option></select></label>
      </div>
    </>
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
