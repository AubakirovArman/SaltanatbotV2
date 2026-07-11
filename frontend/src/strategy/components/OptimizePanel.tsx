import { Loader2, SlidersHorizontal } from "lucide-react";
import type { StrategyIR } from "../ir";
import type { Objective, OptimizeResult, WalkForwardResult } from "../optimizer";
import { OBJECTIVES, comboCount, type AxisState, type OptSpecState } from "../optimization/model";
import type { Locale } from "../../i18n";
import { strategyNumber, strategyObjective, strategyText } from "../../i18n/strategy";

const MAX_COMBOS = 2000;

export function OptimizePanel({
  locale,
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
  locale: Locale;
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
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
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
          <SlidersHorizontal size={13} aria-hidden="true" /> {t("optimizer")}
        </strong>
        <span>{combos > MAX_COMBOS ? `${MAX_COMBOS}+ ${t("combos")}` : `${strategyNumber(locale, combos)} ${t(combos === 1 ? "combo" : "combos")}`}</span>
      </div>

      <div className="opt-axes">
        {inputs.map((input) => {
          const axis = spec.axes.find((a) => a.name === input.name);
          if (!axis) return null;
          const disabled = !axis.enabled && enabledCount >= 3;
          return (
            <div key={input.name} className={axis.enabled ? "opt-axis on" : "opt-axis"}>
              <label className="opt-axis-toggle" title={disabled ? t("maxParameters") : undefined}>
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
        <label>
          {t("trainPercent")}
          <input type="number" value={Math.round(spec.trainFrac * 100)} min={20} max={90} step={5} onChange={(event) => onSpecChange({ ...spec, trainFrac: clamp01((Number(event.target.value) || 70) / 100) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={walkForwardOn} onChange={(event) => onToggleWalkForward(event.target.checked)} />
          {t("walkForwardShort")}
        </label>
        {walkForwardOn && (
          <label>
            {t("folds")}
            <input type="number" value={folds} min={2} max={12} step={1} onChange={(event) => onFoldsChange(Math.max(2, Math.min(12, Number(event.target.value) || 4)))} />
          </label>
        )}
      </div>

      {combos > MAX_COMBOS && (
        <div className="opt-hint">
          {locale === "ru"
            ? `Сетка содержит ${strategyNumber(locale, combos)} комбинаций — будут проверены только первые ${strategyNumber(locale, MAX_COMBOS)}. Увеличьте шаг, чтобы уменьшить сетку.`
            : `Grid has ${strategyNumber(locale, combos)} combos — only the first ${strategyNumber(locale, MAX_COMBOS)} will be evaluated. Widen the step to shrink the grid.`}
        </div>
      )}

      <button type="button" className="run-button" onClick={onRun} disabled={optimizing || enabledCount === 0}>
        {optimizing ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <SlidersHorizontal size={15} aria-hidden="true" />}
        {optimizing ? (progress.total ? `${t("optimizing")} ${progress.done}/${progress.total}` : t("optimizing")) : t("runOptimizer")}
      </button>

      {optimizing && (
        <div className="opt-progress">
          <div className="opt-progress-bar" style={{ inlineSize: `${pct}%` }} />
        </div>
      )}

      {result && !optimizing && <OptimizeResults locale={locale} result={result} onApplyCombo={onApplyCombo} />}
      {walkForwardOn && walkForwardResult && !optimizing && <WalkForwardResults locale={locale} wf={walkForwardResult} decimals={decimals} />}
    </div>
  );
}
function OptimizeResults({ locale, result, onApplyCombo }: { locale: Locale; result: OptimizeResult; onApplyCombo: (params: Record<string, number>) => void }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const rows = result.ranked.slice(0, 20);
  const keys = result.ranked[0] ? Object.keys(result.ranked[0].params) : [];
  return (
    <div className="opt-results">
      <div className="panel-header small">
        <strong>{t("ranked")} · {strategyObjective(locale, result.objective)}</strong>
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
        <strong>{t("walkForward")} · {wf.folds.length} {t("folds").toLowerCase()}</strong>
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
          <span>{t("oosTrades")} {agg.totalTrades}</span>
          <span>{t("win")} {agg.winRate.toFixed(0)}%</span>
          <span>PF {Number.isFinite(agg.profitFactor) ? agg.profitFactor.toFixed(2) : "∞"}</span>
          <span>{t("maxDrawdownShort")} {agg.maxDrawdownPct.toFixed(1)}%</span>
          <span title={t("finalEquity")}>{t("final")} {agg.finalEquity.toFixed(decimals === 0 ? 0 : 2)}</span>
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
