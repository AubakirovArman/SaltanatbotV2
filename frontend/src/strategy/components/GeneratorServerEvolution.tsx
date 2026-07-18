import { Dna, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { localeTag } from "../../i18n";
import {
  GA_EMBARGO_MAX_BARS,
  GA_EMBARGO_MIN_BARS,
  GA_GENERATIONS_MAX,
  GA_GENERATIONS_MIN,
  GA_LOOKBACK_MAX_BARS,
  GA_LOOKBACK_MIN_BARS,
  GA_MAX_MARKETS,
  GA_POPULATION_MAX,
  GA_POPULATION_MIN,
  GA_RUN_POLL_INTERVAL_MS,
  GA_SEED_MAX,
  GA_TRAIN_FRACTION_MAX,
  GA_TRAIN_FRACTION_MIN,
  GaEvolutionApiError,
  cancelGaEvolutionJob,
  getGaCandidate,
  getGaRun,
  isActiveGaRunStatus,
  listGaRuns,
  promoteGaCandidate,
  resumeGaEvolutionRun,
  startGaEvolutionRun,
  type GaCandidateSummary,
  type GaRunDetail,
  type GaRunStatus,
  type GaRunSummary
} from "../gaEvolutionClient";
import { promotedGaCandidateToPortableArtifact } from "../gaPromotedArtifact";
import type { generatorText } from "../generatorText";
import type { PortableStrategyArtifact } from "../strategyFile";
import { GeneratorEvolutionFrontier, type EvolutionDrawerState } from "./GeneratorEvolutionFrontier";

/**
 * Server GA evolution section (R9.2): configure and start a seeded evolution
 * run, follow status/generation progress by polling, cancel to a checkpoint,
 * resume checkpointed runs, inspect the Pareto frontier and promote clean
 * candidates into the owner's own strategy library through the existing
 * portable artifact flow. Nothing is fetched on mount — the run list loads on
 * explicit user action and polls only while a run is active.
 */

type GeneratorKey = Parameters<typeof generatorText>[1];
type Translate = (key: GeneratorKey) => string;

const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKET_CHOICES: readonly string[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT"];
const TIMEFRAME_CHOICES: readonly string[] = ["15m", "1h", "4h", "1d"];

const STATUS_TEXT: Record<GaRunStatus, GeneratorKey> = {
  running: "serverEvalStateRunning",
  checkpointed: "serverEvolutionStatusCheckpointed",
  completed: "serverEvolutionStatusCompleted",
  failed: "serverEvalStateFailed",
  cancelled: "serverEvolutionStatusCancelled"
};

/** Data-driven integer controls: same bounds the client re-validates on submit. */
const NUMBER_FIELDS: readonly { key: "lookbackBars" | "embargoBars" | "seed" | "population" | "generations"; label: GeneratorKey; min: number; max: number; step: number }[] = [
  { key: "lookbackBars", label: "serverEvalLookback", min: GA_LOOKBACK_MIN_BARS, max: GA_LOOKBACK_MAX_BARS, step: 100 },
  { key: "embargoBars", label: "serverEvalEmbargo", min: GA_EMBARGO_MIN_BARS, max: GA_EMBARGO_MAX_BARS, step: 1 },
  { key: "seed", label: "seed", min: 0, max: GA_SEED_MAX, step: 1 },
  { key: "population", label: "population", min: GA_POPULATION_MIN, max: GA_POPULATION_MAX, step: 1 },
  { key: "generations", label: "generations", min: GA_GENERATIONS_MIN, max: GA_GENERATIONS_MAX, step: 1 }
];

interface EvolutionFormState {
  symbols: string[];
  timeframe: string;
  lookbackBars: number;
  trainFraction: number;
  embargoBars: number;
  seed: number;
  population: number;
  generations: number;
}

const DEFAULT_EVOLUTION_FORM: EvolutionFormState = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  timeframe: "1h",
  lookbackBars: 3_000,
  trainFraction: 0.7,
  embargoBars: 8,
  seed: 42,
  population: 16,
  generations: 4
};

interface GeneratorServerEvolutionProps {
  locale: Locale;
  ownerUserId?: string;
  onImport: (artifact: PortableStrategyArtifact) => void;
  t: Translate;
}

export function GeneratorServerEvolution({ locale, ownerUserId, onImport, t }: GeneratorServerEvolutionProps) {
  const owner = typeof ownerUserId === "string" && OWNER_UUID.test(ownerUserId) ? ownerUserId : undefined;
  const [form, setForm] = useState<EvolutionFormState>(DEFAULT_EVOLUTION_FORM);
  const [runs, setRuns] = useState<GaRunSummary[]>();
  const [runsBusy, setRunsBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [resumingRunId, setResumingRunId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [detail, setDetail] = useState<GaRunDetail>();
  const [drawer, setDrawer] = useState<EvolutionDrawerState>();
  const [promotingFingerprint, setPromotingFingerprint] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const aliveRef = useRef(true);
  const sectionId = useId();
  const fieldId = useId();
  const formatter = useMemo(() => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }), [locale]);
  const hasActiveRun = runs?.some((run) => isActiveGaRunStatus(run.status)) ?? false;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Bounded progress polling: re-arms only while the loaded list has an
  // active run, so an idle panel performs zero background requests.
  useEffect(() => {
    if (!owner || !hasActiveRun) return;
    const timer = window.setTimeout(() => void refreshRuns(), GA_RUN_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [owner, runs]);

  const refreshRuns = async (showBusy = false) => {
    if (!owner) return;
    if (showBusy) setRunsBusy(true);
    try {
      const nextRuns = await listGaRuns(owner);
      if (!aliveRef.current) return;
      setRuns(nextRuns);
      setError(undefined);
      const selected = selectedRunId ? nextRuns.find((run) => run.id === selectedRunId) : undefined;
      if (selected) {
        const nextDetail = await getGaRun(owner, selected.id);
        if (!aliveRef.current) return;
        setDetail(nextDetail);
      } else if (selectedRunId) {
        setSelectedRunId(undefined);
        setDetail(undefined);
        setDrawer(undefined);
      }
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(`${t("serverEvolutionLoadFailed")}: ${failureText(t, caught)}`);
    } finally {
      if (aliveRef.current && showBusy) setRunsBusy(false);
    }
  };

  const startEvolution = async () => {
    if (!owner || starting) return;
    setStarting(true);
    setStatus(undefined);
    setError(undefined);
    try {
      await startGaEvolutionRun(owner, {
        markets: form.symbols,
        timeframe: form.timeframe,
        lookbackBars: form.lookbackBars,
        split: { trainFraction: form.trainFraction, embargoBars: form.embargoBars },
        seed: form.seed,
        population: form.population,
        generations: form.generations
      });
      if (!aliveRef.current) return;
      await refreshRuns(true);
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(failureText(t, caught));
    } finally {
      if (aliveRef.current) setStarting(false);
    }
  };

  const cancelRun = async (run: GaRunSummary) => {
    if (!owner || !run.jobId) return;
    // The worker checkpoints the run; the poll loop observes the new status.
    await cancelGaEvolutionJob(owner, run.jobId);
    await refreshRuns();
  };

  const resumeRun = async (run: GaRunSummary) => {
    if (!owner || resumingRunId) return;
    setResumingRunId(run.id);
    setStatus(undefined);
    setError(undefined);
    try {
      await resumeGaEvolutionRun(owner, run.id);
      if (!aliveRef.current) return;
      await refreshRuns(true);
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(failureText(t, caught));
    } finally {
      if (aliveRef.current) setResumingRunId(undefined);
    }
  };

  const showFrontier = async (run: GaRunSummary) => {
    if (!owner) return;
    setSelectedRunId(run.id);
    setDrawer(undefined);
    try {
      const nextDetail = await getGaRun(owner, run.id);
      if (!aliveRef.current) return;
      setDetail(nextDetail);
    } catch (caught) {
      if (!aliveRef.current) return;
      setDetail(undefined);
      setError(`${t("serverEvolutionLoadFailed")}: ${failureText(t, caught)}`);
    }
  };

  const inspectCandidate = async (fingerprint: string) => {
    if (!owner || !selectedRunId) return;
    setDrawer({ fingerprint, loading: true });
    try {
      const candidate = await getGaCandidate(owner, selectedRunId, fingerprint);
      if (!aliveRef.current) return;
      setDrawer({ fingerprint, detail: candidate, loading: false });
    } catch (caught) {
      if (!aliveRef.current) return;
      setDrawer({ fingerprint, loading: false, error: `${t("serverEvolutionCandidateLoadFailed")}: ${failureText(t, caught)}` });
    }
  };

  const promoteCandidate = async (candidate: GaCandidateSummary) => {
    if (!owner || !selectedRunId || promotingFingerprint) return;
    setPromotingFingerprint(candidate.fingerprint);
    setStatus(undefined);
    setError(undefined);
    try {
      const bundle = await promoteGaCandidate(owner, selectedRunId, candidate.fingerprint);
      const artifact = promotedGaCandidateToPortableArtifact(bundle, t("serverEvolutionArtifactDescription"));
      if (!aliveRef.current) return;
      setStatus(t("serverEvolutionPromoted"));
      onImport(artifact);
      if (!aliveRef.current) return;
      await refreshRuns();
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(`${t("serverEvolutionPromoteFailed")}: ${failureText(t, caught)}`);
    } finally {
      if (aliveRef.current) setPromotingFingerprint(undefined);
    }
  };

  const toggleSymbol = (symbol: string) => {
    setForm((current) => {
      const active = current.symbols.includes(symbol);
      if (active && current.symbols.length === 1) return current;
      if (!active && current.symbols.length >= GA_MAX_MARKETS) return current;
      return { ...current, symbols: active ? current.symbols.filter((entry) => entry !== symbol) : [...current.symbols, symbol] };
    });
  };

  const numberField = (key: "lookbackBars" | "embargoBars" | "seed" | "population" | "generations", value: number, min: number, max: number) => {
    setForm((current) => ({ ...current, [key]: boundedInteger(value, min, max) }));
  };

  return (
    <section className="strategy-generator-server-evolution" aria-labelledby={sectionId}>
      <strong id={sectionId}><Dna size={15} aria-hidden="true" /> {t("serverEvolution")}</strong>
      <p>{t("serverEvolutionIntro")}</p>
      {!owner ? (
        <p className="strategy-generator-eval-hint" role="status">{t("serverEvolutionSignIn")}</p>
      ) : (
        <>
          <form className="strategy-generator-eval-form" onSubmit={(event) => { event.preventDefault(); void startEvolution(); }}>
            <fieldset>
              <legend>{t("serverEvalMarkets")}</legend>
              <p>{t("serverEvolutionMarketsHint")}</p>
              <div className="strategy-generator-eval-markets">
                {MARKET_CHOICES.map((symbol) => {
                  const checked = form.symbols.includes(symbol);
                  return (
                    <label key={symbol}>
                      <input
                        name="evolution-market"
                        type="checkbox"
                        value={symbol}
                        checked={checked}
                        disabled={(!checked && form.symbols.length >= GA_MAX_MARKETS) || (checked && form.symbols.length === 1)}
                        onChange={() => toggleSymbol(symbol)}
                      />
                      {symbol}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="strategy-generator-eval-settings">
              <label htmlFor={`${fieldId}-timeframe`}>
                {t("serverEvalTimeframe")}
                <select id={`${fieldId}-timeframe`} value={form.timeframe} onChange={(event) => setForm((current) => ({ ...current, timeframe: event.target.value }))}>
                  {TIMEFRAME_CHOICES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
                </select>
              </label>
              <label htmlFor={`${fieldId}-train`}>
                {t("serverEvalTrainFraction")}
                <input id={`${fieldId}-train`} type="number" min={GA_TRAIN_FRACTION_MIN} max={GA_TRAIN_FRACTION_MAX} step={0.05} required value={form.trainFraction} onChange={(event) => setForm((current) => ({ ...current, trainFraction: boundedFraction(event.target.valueAsNumber) }))} />
              </label>
              {NUMBER_FIELDS.map((field) => (
                <label key={field.key} htmlFor={`${fieldId}-${field.key}`}>
                  {t(field.label)}
                  <input id={`${fieldId}-${field.key}`} type="number" min={field.min} max={field.max} step={field.step} required value={form[field.key]} onChange={(event) => numberField(field.key, event.target.valueAsNumber, field.min, field.max)} />
                </label>
              ))}
            </div>
            <div className="strategy-generator-actions">
              <button type="submit" className="primary" disabled={starting || hasActiveRun}>
                {starting ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Dna size={15} aria-hidden="true" />}
                {starting ? t("serverEvolutionStarting") : t("serverEvolutionStart")}
              </button>
              <button type="button" disabled={runsBusy} onClick={() => void refreshRuns(true)}>
                {runsBusy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                {t("serverEvolutionRefresh")}
              </button>
            </div>
            {hasActiveRun && <p className="strategy-generator-eval-hint" role="status">{t("serverEvolutionActiveError")}</p>}
          </form>
          {status && <p className="strategy-generator-status" role="status" aria-live="polite">{status}</p>}
          {error && <p className="strategy-generator-error" role="alert">{error}</p>}
          {runs !== undefined && (
            <div className="strategy-generator-evolution-runs">
              <strong>{t("serverEvolutionRuns")}</strong>
              {runs.length === 0 ? (
                <p role="status">{t("serverEvolutionNoRuns")}</p>
              ) : (
                <ul aria-label={t("serverEvolutionRuns")}>
                  {runs.map((run) => (
                    <EvolutionRunRow
                      key={run.id}
                      run={run}
                      selected={run.id === selectedRunId}
                      resuming={resumingRunId === run.id}
                      onCancel={() => void cancelRun(run)}
                      onResume={() => void resumeRun(run)}
                      onShowFrontier={() => void showFrontier(run)}
                      formatter={formatter}
                      t={t}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {detail && (
            <GeneratorEvolutionFrontier
              run={detail}
              drawer={drawer}
              promotingFingerprint={promotingFingerprint}
              onInspect={(fingerprint) => void inspectCandidate(fingerprint)}
              onCloseDrawer={() => setDrawer(undefined)}
              onPromote={(candidate) => void promoteCandidate(candidate)}
              formatter={formatter}
              t={t}
            />
          )}
        </>
      )}
    </section>
  );
}

function EvolutionRunRow({ run, selected, resuming, onCancel, onResume, onShowFrontier, formatter, t }: {
  run: GaRunSummary;
  selected: boolean;
  resuming: boolean;
  onCancel: () => void;
  onResume: () => void;
  onShowFrontier: () => void;
  formatter: Intl.NumberFormat;
  t: Translate;
}) {
  const generations = run.generations ?? 0;
  const currentGeneration = run.currentGeneration ?? 0;
  return (
    <li data-run-status={run.status} className={selected ? "selected" : undefined}>
      <span className="strategy-generator-candidate-name">
        <span>{t("serverEvolutionRun")} <code title={run.id}>{run.id.slice(0, 8)}</code> · {run.markets.join(", ")}{run.timeframe ? ` · ${run.timeframe}` : ""}</span>
        <span>
          {t("seed")}: {run.seed ?? "—"} · {t("generation")} {formatter.format(currentGeneration)}/{formatter.format(generations)}
          {run.datasetFingerprint ? <> · {t("rankingDataset")}: <code className="strategy-generator-dataset-fingerprint">{run.datasetFingerprint.slice(0, 16)}…</code></> : null}
        </span>
      </span>
      <span className={`strategy-generator-eval-state is-${run.status}`} role="status" aria-live="polite">{t(STATUS_TEXT[run.status])}</span>
      {generations > 0 && <progress max={generations} value={Math.min(currentGeneration, generations)} aria-label={`${t("generation")} ${currentGeneration}/${generations}`} />}
      <span className="strategy-generator-evolution-row-actions">
        {isActiveGaRunStatus(run.status) && run.jobId && (
          <button type="button" onClick={onCancel} aria-label={`${t("serverEvolutionCancelRun")}: ${run.id}`}>{t("serverEvolutionCancelRun")}</button>
        )}
        {run.status === "checkpointed" && (
          <button type="button" disabled={resuming} onClick={onResume} aria-label={`${t("serverEvolutionResumeRun")}: ${run.id}`}>
            {resuming ? t("serverEvolutionResuming") : t("serverEvolutionResumeRun")}
          </button>
        )}
        <button type="button" onClick={onShowFrontier} aria-label={`${t("serverEvolutionFrontier")}: ${run.id}`}>{t("serverEvolutionFrontier")}</button>
      </span>
    </li>
  );
}

function failureText(t: Translate, error: unknown): string {
  if (error instanceof GaEvolutionApiError) {
    if (error.code === "job_quota_exceeded") return t("serverEvalQuotaError");
    if (error.code === "ga_dataset_drift") return t("serverEvolutionDatasetDrift");
    if (error.code === "ga_promotion_requires_oos") return t("serverEvolutionPromoteNoOos");
    if (error.code === "ga_promotion_overfit") return t("serverEvolutionPromoteOverfit");
    if (error.code.startsWith("ga_run_active") || error.code === "ga_active_run_exists") return t("serverEvolutionActiveError");
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function boundedFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EVOLUTION_FORM.trainFraction;
  const bounded = Math.min(GA_TRAIN_FRACTION_MAX, Math.max(GA_TRAIN_FRACTION_MIN, value));
  return Math.round(bounded * 100) / 100;
}
