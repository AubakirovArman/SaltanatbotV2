import { Dna, Loader2, SlidersHorizontal } from "lucide-react";
import type { StrategyIR } from "../ir";
import type { GeneticOptimizeResult, GeneticProgress } from "../geneticOptimizer";
import type { Objective, OptimizeResult, WalkForwardResult } from "../optimizer";
import { OBJECTIVES, comboCount, type AxisState, type OptSpecState } from "../optimization/model";
import { localized, type Locale } from "../../i18n";
import { strategyNumber, strategyObjective, strategyText } from "../../i18n/strategy";

const MAX_COMBOS = 2000;

export function OptimizePanel({
  locale,
  spec,
  inputs,
  onSpecChange,
  onRun,
  onCancel,
  optimizing,
  progress,
  mode,
  onModeChange,
  geneticConfig,
  onGeneticConfigChange,
  geneticResult,
  geneticProgress,
  walkForwardOn,
  onToggleWalkForward,
  folds,
  onFoldsChange,
  walkForwardMode,
  onWalkForwardModeChange,
  result,
  walkForwardResult,
  onApplyCombo,
  decimals
}: {
  locale: Locale;
  spec: OptSpecState;
  inputs: StrategyIR["inputs"];
  onSpecChange: (spec: OptSpecState) => void;
  onRun: () => void;
  onCancel: () => void;
  optimizing: boolean;
  progress: { done: number; total: number };
  mode: "grid" | "genetic";
  onModeChange: (mode: "grid" | "genetic") => void;
  geneticConfig: { populationSize: number; generations: number; mutationRate: number; seed: number };
  onGeneticConfigChange: (config: { populationSize: number; generations: number; mutationRate: number; seed: number }) => void;
  geneticResult?: GeneticOptimizeResult;
  geneticProgress?: GeneticProgress;
  walkForwardOn: boolean;
  onToggleWalkForward: (on: boolean) => void;
  folds: number;
  onFoldsChange: (n: number) => void;
  walkForwardMode: "rolling" | "anchored";
  onWalkForwardModeChange: (mode: "rolling" | "anchored") => void;
  result?: OptimizeResult;
  walkForwardResult?: WalkForwardResult;
  onApplyCombo: (params: Record<string, number>) => void;
  decimals: number;
}) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const enabledCount = spec.axes.filter((axis) => axis.enabled).length;
  const axisLimit = mode === "genetic" ? Math.min(12, inputs.length) : 3;
  const combos = comboCount(spec);
  const pct = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  const switchMode = (nextMode: "grid" | "genetic") => {
    if (nextMode === "grid" && enabledCount > 3) {
      let kept = 0;
      onSpecChange({
        ...spec,
        axes: spec.axes.map((axis) => {
          if (!axis.enabled) return axis;
          kept += 1;
          return kept <= 3 ? axis : { ...axis, enabled: false };
        })
      });
    }
    onModeChange(nextMode);
  };

  const patchAxis = (name: string, patch: Partial<AxisState>) => {
    onSpecChange({
      ...spec,
      axes: spec.axes.map((axis) => {
        if (axis.name !== name) return axis;
        // Keep the larger genetic search space bounded while preserving the
        // existing three-axis cap for exhaustive grid search.
        if (patch.enabled && !axis.enabled && enabledCount >= axisLimit) return axis;
        return { ...axis, ...patch };
      })
    });
  };

  return (
    <div className="optimizer">
      <div className="panel-header small">
        <strong>
          <SlidersHorizontal size={13} aria-hidden="true" /> {t("optimizer")}
        </strong>
        <span>{mode === "genetic" ? `${strategyNumber(locale, geneticConfig.populationSize)} × ${strategyNumber(locale, geneticConfig.generations)}` : combos > MAX_COMBOS ? `${MAX_COMBOS}+ ${t("combos")}` : `${strategyNumber(locale, combos)} ${t(combos === 1 ? "combo" : "combos")}`}</span>
      </div>

      <div className="segmented opt-mode" role="group" aria-label={t("optimizerMode")}>
        <button type="button" className={mode === "grid" ? "active" : ""} aria-pressed={mode === "grid"} disabled={optimizing} onClick={() => switchMode("grid")}>
          <SlidersHorizontal size={13} aria-hidden="true" /> {t("gridSearch")}
        </button>
        <button type="button" className={mode === "genetic" ? "active" : ""} aria-pressed={mode === "genetic"} disabled={optimizing} onClick={() => switchMode("genetic")}>
          <Dna size={13} aria-hidden="true" /> {t("geneticSearch")}
        </button>
      </div>

      <div className="opt-axes">
        {inputs.map((input) => {
          const axis = spec.axes.find((a) => a.name === input.name);
          if (!axis) return null;
          const disabled = !axis.enabled && enabledCount >= axisLimit;
          return (
            <div key={input.name} className={axis.enabled ? "opt-axis on" : "opt-axis"}>
              <label className="opt-axis-toggle" title={disabled ? t(mode === "genetic" ? "maxGeneticParameters" : "maxParameters") : undefined}>
                <input type="checkbox" checked={axis.enabled} disabled={disabled} onChange={(event) => patchAxis(input.name, { enabled: event.target.checked })} />
                <span className="opt-axis-name">{input.name}</span>
                <span className="opt-axis-cur">= {input.value}</span>
              </label>
              {axis.enabled && (
                <div className="opt-axis-range">
                  <label>
                    {t("min")}
                    <input type="number" value={axis.min} onChange={(event) => patchAxis(input.name, { min: Number(event.target.value) })} />
                  </label>
                  <label>
                    {t("max")}
                    <input type="number" value={axis.max} onChange={(event) => patchAxis(input.name, { max: Number(event.target.value) })} />
                  </label>
                  <label>
                    {t("step")}
                    <input type="number" value={axis.step} min={0} onChange={(event) => patchAxis(input.name, { step: Number(event.target.value) })} />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="config-row">
        {mode === "grid" ? (
          <label>
            {t("objective")}
            <select value={spec.objective} onChange={(event) => onSpecChange({ ...spec, objective: event.target.value as Objective })}>
              {OBJECTIVES.map((o) => (
                <option key={o.id} value={o.id}>
                  {strategyObjective(locale, o.id)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="opt-hint">{t("geneticFitnessHint")}</span>
        )}
        <label>
          {t("trainPercent")}
          <input type="number" value={Math.round(spec.trainFrac * 100)} min={20} max={90} step={5} onChange={(event) => onSpecChange({ ...spec, trainFrac: clamp01((Number(event.target.value) || 70) / 100) })} />
        </label>
        {mode === "grid" && (
          <label className="check">
            <input type="checkbox" checked={walkForwardOn} onChange={(event) => onToggleWalkForward(event.target.checked)} />
            {t("walkForwardShort")}
          </label>
        )}
        {mode === "grid" && walkForwardOn && (
          <>
            <label>
              {t("walkForwardMode")}
              <select value={walkForwardMode} onChange={(event) => onWalkForwardModeChange(event.target.value as "rolling" | "anchored")}>
                <option value="rolling">{t("rolling")}</option>
                <option value="anchored">{t("anchored")}</option>
              </select>
            </label>
            <label>
              {t("folds")}
              <input type="number" value={folds} min={2} max={12} step={1} onChange={(event) => onFoldsChange(Math.max(2, Math.min(12, Number(event.target.value) || 4)))} />
            </label>
          </>
        )}
      </div>

      {mode === "genetic" && (
        <fieldset className="config-row genetic-config">
          <legend>{t("geneticSettings")}</legend>
          <label>
            {t("population")}
            <input type="number" min={4} max={256} step={1} value={geneticConfig.populationSize} onChange={(event) => onGeneticConfigChange({ ...geneticConfig, populationSize: bounded(event.target.valueAsNumber, 4, 256, 48) })} />
          </label>
          <label>
            {t("generations")}
            <input type="number" min={1} max={500} step={1} value={geneticConfig.generations} onChange={(event) => onGeneticConfigChange({ ...geneticConfig, generations: bounded(event.target.valueAsNumber, 1, 500, 30) })} />
          </label>
          <label>
            {t("mutationPercent")}
            <input type="number" min={0} max={100} step={1} value={Math.round(geneticConfig.mutationRate * 100)} onChange={(event) => onGeneticConfigChange({ ...geneticConfig, mutationRate: bounded(event.target.valueAsNumber, 0, 100, 15) / 100 })} />
          </label>
          <label>
            {t("seed")}
            <input type="number" min={0} max={4_294_967_295} step={1} value={geneticConfig.seed} onChange={(event) => onGeneticConfigChange({ ...geneticConfig, seed: bounded(event.target.valueAsNumber, 0, 4_294_967_295, 42) })} />
          </label>
        </fieldset>
      )}

      {mode === "grid" && combos > MAX_COMBOS && (
        <div className="opt-hint">
          {localized(locale, {
            en: `Grid has ${strategyNumber(locale, combos)} combos — only the first ${strategyNumber(locale, MAX_COMBOS)} will be evaluated. Widen the step to shrink the grid.`,
            ru: `Сетка содержит ${strategyNumber(locale, combos)} комбинаций — будут проверены только первые ${strategyNumber(locale, MAX_COMBOS)}. Увеличьте шаг, чтобы уменьшить сетку.`,
            kk: `Торда ${strategyNumber(locale, combos)} комбинация бар — тек алғашқы ${strategyNumber(locale, MAX_COMBOS)} тексеріледі. Торды азайту үшін қадамды үлкейтіңіз.`
          })}
        </div>
      )}

      <div className="backtest-controls">
        <button type="button" className="run-button" onClick={onRun} disabled={optimizing || enabledCount === 0}>
          {optimizing ? <Loader2 size={15} className="spin" aria-hidden="true" /> : mode === "genetic" ? <Dna size={15} aria-hidden="true" /> : <SlidersHorizontal size={15} aria-hidden="true" />}
          {optimizing ? (progress.total ? `${t("optimizing")} ${progress.done}/${progress.total}` : t("optimizing")) : t(mode === "genetic" ? "runGeneticOptimizer" : "runOptimizer")}
        </button>
        {optimizing && (
          <button type="button" onClick={onCancel}>
            {t("cancel")}
          </button>
        )}
      </div>

      {optimizing && mode === "genetic" && geneticProgress && (
        <p className="opt-hint" role="status">
          {geneticProgress.phase === "holdout" ? t("finalHoldout") : `${t("generation")} ${geneticProgress.generation}/${geneticProgress.generations}`} · {t("uniqueCandidates")} {geneticProgress.uniqueEvaluated}
        </p>
      )}

      {optimizing && (
        <div className="opt-progress">
          <div className="opt-progress-bar" style={{ inlineSize: `${pct}%` }} />
        </div>
      )}

      {result && !optimizing && <OptimizeResults locale={locale} result={result} onApplyCombo={onApplyCombo} />}
      {geneticResult && !optimizing && <GeneticResults locale={locale} result={geneticResult} onApplyCombo={onApplyCombo} />}
      {mode === "grid" && walkForwardOn && walkForwardResult && !optimizing && <WalkForwardResults locale={locale} wf={walkForwardResult} decimals={decimals} />}
    </div>
  );
}

function GeneticResults({ locale, result, onApplyCombo }: { locale: Locale; result: GeneticOptimizeResult; onApplyCombo: (params: Record<string, number>) => void }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const rows = result.ranked.slice(0, 20);
  const keys = rows[0] ? Object.keys(rows[0].params) : [];
  return (
    <section className="opt-results" aria-labelledby="genetic-results-title">
      <div className="panel-header small">
        <strong id="genetic-results-title">{t("geneticResults")}</strong>
        <span>
          {t("uniqueCandidates")} {strategyNumber(locale, result.uniqueEvaluated)} · {t("searchSpace")} {strategyNumber(locale, result.searchSpaceSize)}
        </span>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the horizontally scrollable results region must be keyboard reachable. */}
      <div className="opt-table" role="region" aria-label={t("geneticResults")} tabIndex={0}>
        <table>
          <caption className="sr-only">{t("geneticResults")}</caption>
          <thead>
            <tr>
              <th scope="col">{keys.join(" · ") || t("params")}</th>
              <th scope="col">{t("fitness")}</th>
              <th scope="col">{t("validationPnl")}</th>
              <th scope="col">{t("testPnl")}</th>
              <th scope="col">{t("testDrawdown")}</th>
              <th scope="col">{t("holdoutGate")}</th>
              <th scope="col">{t("apply")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isFinalWinner = row.canonicalKey === result.best?.canonicalKey;
              const canApply = isFinalWinner && row.holdout?.passed === true;
              return (
                <tr key={row.canonicalKey}>
                  <td className="opt-params">{keys.map((key) => row.params[key]).join(" · ")}</td>
                  <td>{fmtScore(row.fitness.total)}</td>
                  <td className={row.validationSample.netProfitPct >= 0 ? "up" : "down"}>
                    {row.validationSample.netProfitPct >= 0 ? "+" : ""}
                    {row.validationSample.netProfitPct.toFixed(2)}%
                  </td>
                  <td className={row.testSample ? (row.testSample.netProfitPct >= 0 ? "up" : "down") : undefined}>{row.testSample ? `${row.testSample.netProfitPct >= 0 ? "+" : ""}${row.testSample.netProfitPct.toFixed(2)}%` : "—"}</td>
                  <td>{row.testSample ? `${row.testSample.maxDrawdownPct.toFixed(2)}%` : "—"}</td>
                  <td className={row.holdout ? (row.holdout.passed ? "up" : "down") : undefined}>{row.holdout ? t(row.holdout.passed ? "validated" : "rejectedOos") : t("notEvaluated")}</td>
                  <td>
                    {canApply ? (
                      <button type="button" className="link-button" onClick={() => onApplyCombo(row.params)}>
                        {t("apply")}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function OptimizeResults({ locale, result, onApplyCombo }: { locale: Locale; result: OptimizeResult; onApplyCombo: (params: Record<string, number>) => void }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const rows = result.ranked.slice(0, 20);
  const keys = result.ranked[0] ? Object.keys(result.ranked[0].params) : [];
  return (
    <div className="opt-results">
      <div className="panel-header small">
        <strong>
          {t("ranked")} · {strategyObjective(locale, result.objective)}
        </strong>
        <span>
          {result.evaluated}/{result.totalCombos}
          {result.truncated ? ` (${t("capped")})` : ""}
        </span>
      </div>
      <div className="opt-table" role="table">
        <div className="opt-row head" role="row">
          <span>{keys.join(" · ") || t("params")}</span>
          <span title={t("inSampleScore")}>IS</span>
          <span title={t("outSampleScore")}>OOS</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="opt-row" role="row" key={i}>
            <span className="opt-params">{keys.map((k) => row.params[k]).join(" · ")}</span>
            <span className="opt-score">{fmtScore(row.score)}</span>
            <span className={`opt-score ${row.outScore === undefined ? "" : row.outScore >= 0 ? "up" : "down"}`}>{row.outScore === undefined ? "—" : fmtScore(row.outScore)}</span>
            <button type="button" className="link-button" onClick={() => onApplyCombo(row.params)}>
              {t("apply")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function WalkForwardResults({ locale, wf, decimals }: { locale: Locale; wf: WalkForwardResult; decimals: number }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  if (wf.folds.length === 0) {
    return <div className="opt-hint">{t("insufficientWalkForward")}</div>;
  }
  const agg = wf.aggregate;
  const keys = Object.keys(wf.folds[0].params);
  return (
    <div className="opt-results">
      <div className="panel-header small">
        <strong>
          {t("walkForward")} · {wf.folds.length} {t("folds").toLowerCase()}
        </strong>
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
          <span>{keys.join(" · ") || t("params")}</span>
          <span title={t("outSampleNetHelp")}>{t("outSampleNet")}</span>
          <span title={t("outSampleTrades")}>{t("trades")}</span>
          <span title={t("outSampleWinRate")}>{t("winPercent")}</span>
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
          <span>
            {t("oosTrades")} {agg.totalTrades}
          </span>
          <span>
            {t("win")} {agg.winRate.toFixed(0)}%
          </span>
          <span>PF {Number.isFinite(agg.profitFactor) ? agg.profitFactor.toFixed(2) : "∞"}</span>
          <span>
            {t("maxDrawdownShort")} {agg.maxDrawdownPct.toFixed(1)}%
          </span>
          <span title={t("finalEquity")}>
            {t("final")} {agg.finalEquity.toFixed(decimals === 0 ? 0 : 2)}
          </span>
        </div>
      )}
      {wf.stability.length > 0 && (
        <div className="opt-stability">
          <div className="panel-header small">
            <strong>{t("parameterStability")}</strong>
            <span>{t(wf.mode)}</span>
          </div>
          {wf.stability.map((item) => (
            <div key={item.name} className="opt-stability-row">
              <code>{item.name}</code>
              <span>
                {item.min.toFixed(3)}–{item.max.toFixed(3)}
              </span>
              <strong className={item.stable ? "up" : "down"}>{t(item.stable ? "stable" : "unstable")}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

function bounded(value: number, minimum: number, maximum: number, fallback: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(finite)));
}
