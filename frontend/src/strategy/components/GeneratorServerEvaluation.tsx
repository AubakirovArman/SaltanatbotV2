import { Loader2, ServerCog } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { localeTag } from "../../i18n";
import {
  EVALUATION_DEFAULT_EMBARGO_BARS,
  EVALUATION_DEFAULT_TRAIN_FRACTION,
  EVALUATION_EMBARGO_MAX_BARS,
  EVALUATION_EMBARGO_MIN_BARS,
  EVALUATION_LOOKBACK_MAX_BARS,
  EVALUATION_LOOKBACK_MIN_BARS,
  EVALUATION_MAX_MARKETS,
  EVALUATION_TRAIN_FRACTION_MAX,
  EVALUATION_TRAIN_FRACTION_MIN,
  EvaluationApiError,
  cancelEvaluationJob,
  runMultiMarketEvaluation
} from "../evaluationClient";
import {
  rankMultiMarketEvaluations,
  type CandidateEvaluationSet,
  type GeneratedStrategyCandidate,
  type MarketEvaluation
} from "../generator";
import type { generatorText } from "../generatorText";

/**
 * Server-side multi-market evaluation for generated candidates (R9.1c). Jobs
 * run on the research worker with real exchange bars; this panel only submits,
 * polls and surfaces state. Completed results feed the PURE ranker — the
 * generator package never fetches data or scores candidates itself.
 */

type GeneratorKey = Parameters<typeof generatorText>[1];
type Translate = (key: GeneratorKey) => string;

const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKET_CHOICES: readonly string[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT"];
const TIMEFRAME_CHOICES: readonly string[] = ["15m", "1h", "4h", "1d"];
/** Mirrors the server's per-owner active compute-job quota. */
const MAX_ACTIVE_EVALUATIONS = 5;
/** Scores at or below this bound mean the ranker failed the entry closed. */
const FAIL_SCORE_DISPLAY_BOUND = -1e11;

type EvaluationJobPhase = "submitting" | "queued" | "running" | "completed" | "failed" | "cancelled";

interface EvaluationJobState {
  phase: EvaluationJobPhase;
  candidateName: string;
  jobId?: string;
  message?: string;
}

interface StoredEvaluation {
  candidateFingerprint: string;
  datasetFingerprint: string;
  engineVersion: string;
  seed: number;
  markets: MarketEvaluation[];
}

interface EvaluationStore {
  /** Cache keyed by candidate fingerprint + dataset fingerprint. */
  byKey: ReadonlyMap<string, StoredEvaluation>;
  latestKeyByCandidate: ReadonlyMap<string, string>;
}

interface EvaluationFormState {
  symbols: string[];
  timeframe: string;
  lookbackBars: number;
  trainFraction: number;
  embargoBars: number;
}

const DEFAULT_EVALUATION_FORM: EvaluationFormState = {
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  timeframe: "1h",
  lookbackBars: 3_000,
  trainFraction: EVALUATION_DEFAULT_TRAIN_FRACTION,
  embargoBars: EVALUATION_DEFAULT_EMBARGO_BARS
};

const PHASE_TEXT: Record<EvaluationJobPhase, GeneratorKey> = {
  submitting: "serverEvalStateSubmitting",
  queued: "serverEvalStateQueued",
  running: "serverEvalStateRunning",
  completed: "serverEvalStateCompleted",
  failed: "serverEvalStateFailed",
  cancelled: "serverEvalStateCancelled"
};

interface GeneratorServerEvaluationProps {
  locale: Locale;
  ownerUserId?: string;
  candidates: readonly GeneratedStrategyCandidate[];
  selected?: GeneratedStrategyCandidate;
  seed: number;
  t: Translate;
}

export function GeneratorServerEvaluation({ locale, ownerUserId, candidates, selected, seed, t }: GeneratorServerEvaluationProps) {
  const owner = typeof ownerUserId === "string" && OWNER_UUID.test(ownerUserId) ? ownerUserId : undefined;
  const [form, setForm] = useState<EvaluationFormState>(DEFAULT_EVALUATION_FORM);
  const [jobs, setJobs] = useState<ReadonlyMap<string, EvaluationJobState>>(new Map());
  const [store, setStore] = useState<EvaluationStore>({ byKey: new Map(), latestKeyByCandidate: new Map() });
  const controllersRef = useRef(new Map<string, AbortController>());
  const aliveRef = useRef(true);
  const sectionId = useId();
  const rankingId = useId();
  const fieldId = useId();
  const formatter = useMemo(() => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }), [locale]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    };
  }, []);

  const candidateNames = useMemo(() => new Map(candidates.map((candidate) => [candidate.fingerprint, candidate.ir.name])), [candidates]);
  const jobEntries = [...jobs.entries()];
  const activeCount = jobEntries.filter(([, job]) => isActivePhase(job.phase)).length;
  const selectedJob = selected ? jobs.get(selected.fingerprint) : undefined;
  const selectedActive = selectedJob !== undefined && isActivePhase(selectedJob.phase);
  const canSubmit = Boolean(owner && selected?.validation.valid && !selectedActive && activeCount < MAX_ACTIVE_EVALUATIONS && form.symbols.length >= 1);

  const ranking = useMemo(() => {
    const evaluations: CandidateEvaluationSet[] = [];
    const provenance = new Map<string, StoredEvaluation>();
    for (const candidate of candidates) {
      const key = store.latestKeyByCandidate.get(candidate.fingerprint);
      const stored = key ? store.byKey.get(key) : undefined;
      if (!stored) continue;
      evaluations.push({ candidateFingerprint: candidate.fingerprint, markets: stored.markets });
      provenance.set(candidate.fingerprint, stored);
    }
    return { ranked: evaluations.length ? rankMultiMarketEvaluations(evaluations) : [], provenance };
  }, [candidates, store]);

  const setJob = (fingerprint: string, update: (previous: EvaluationJobState | undefined) => EvaluationJobState) => {
    setJobs((previous) => {
      const next = new Map(previous);
      next.set(fingerprint, update(previous.get(fingerprint)));
      return next;
    });
  };

  const toggleSymbol = (symbol: string) => {
    setForm((current) => {
      const active = current.symbols.includes(symbol);
      if (active && current.symbols.length === 1) return current;
      if (!active && current.symbols.length >= EVALUATION_MAX_MARKETS) return current;
      return { ...current, symbols: active ? current.symbols.filter((entry) => entry !== symbol) : [...current.symbols, symbol] };
    });
  };

  const evaluateSelected = async () => {
    if (!owner || !selected?.validation.valid || !canSubmit) return;
    const candidate = selected;
    const fingerprint = candidate.fingerprint;
    const controller = new AbortController();
    controllersRef.current.set(fingerprint, controller);
    const candidateName = candidate.ir.name;
    setJob(fingerprint, () => ({ phase: "submitting", candidateName }));
    try {
      const result = await runMultiMarketEvaluation(owner, {
        ir: candidate.ir,
        markets: form.symbols.map((symbol) => ({ symbol, timeframe: form.timeframe })),
        lookbackBars: form.lookbackBars,
        split: { trainFraction: form.trainFraction, embargoBars: form.embargoBars },
        seed
      }, {
        signal: controller.signal,
        onJob: (snapshot) => {
          if (!aliveRef.current || controller.signal.aborted) return;
          setJob(fingerprint, (previous) => ({
            phase: snapshot.status === "queued" || snapshot.status === "running" ? snapshot.status : previous?.phase ?? "queued",
            candidateName,
            jobId: snapshot.id
          }));
        }
      });
      if (!aliveRef.current || controller.signal.aborted) return;
      const stored: StoredEvaluation = {
        candidateFingerprint: fingerprint,
        datasetFingerprint: result.datasetFingerprint,
        engineVersion: result.engineVersion,
        seed: result.seed,
        markets: result.markets.map((market) => ({ marketId: `${market.symbol}:${market.timeframe}`, train: market.train, outOfSample: market.outOfSample }))
      };
      setStore((previous) => {
        const cacheKey = `${fingerprint}\n${result.datasetFingerprint}`;
        const byKey = new Map(previous.byKey);
        const latestKeyByCandidate = new Map(previous.latestKeyByCandidate);
        byKey.set(cacheKey, stored);
        latestKeyByCandidate.set(fingerprint, cacheKey);
        return { byKey, latestKeyByCandidate };
      });
      setJob(fingerprint, (previous) => ({ phase: "completed", candidateName, jobId: previous?.jobId }));
    } catch (error) {
      if (!aliveRef.current || controller.signal.aborted) return;
      if (error instanceof EvaluationApiError && error.code === "run_cancelled") {
        setJob(fingerprint, (previous) => ({ phase: "cancelled", candidateName, jobId: previous?.jobId }));
        return;
      }
      setJob(fingerprint, (previous) => ({ phase: "failed", candidateName, jobId: previous?.jobId, message: failureText(t, error) }));
    } finally {
      controllersRef.current.delete(fingerprint);
    }
  };

  const cancelJob = (fingerprint: string) => {
    const job = jobs.get(fingerprint);
    if (!job || !isActivePhase(job.phase)) return;
    if (owner && job.jobId) {
      // The poll loop observes the cancelled terminal state and flips the row.
      void cancelEvaluationJob(owner, job.jobId);
      return;
    }
    controllersRef.current.get(fingerprint)?.abort();
    controllersRef.current.delete(fingerprint);
    setJob(fingerprint, (previous) => ({ phase: "cancelled", candidateName: previous?.candidateName ?? fingerprint, jobId: previous?.jobId }));
  };

  const scoreText = (value: number) => (Number.isFinite(value) && value > FAIL_SCORE_DISPLAY_BOUND ? formatter.format(value) : t("rankingScoreFailed"));

  return (
    <>
      <section className="strategy-generator-server-eval" aria-labelledby={sectionId}>
        <strong id={sectionId}><ServerCog size={15} aria-hidden="true" /> {t("serverEval")}</strong>
        <p>{t("serverEvalIntro")}</p>
        {!owner ? (
          <p className="strategy-generator-eval-hint" role="status">{t("serverEvalSignIn")}</p>
        ) : (
          <form className="strategy-generator-eval-form" onSubmit={(event) => { event.preventDefault(); void evaluateSelected(); }}>
            <fieldset>
              <legend>{t("serverEvalMarkets")}</legend>
              <p>{t("serverEvalMarketsHint")}</p>
              <div className="strategy-generator-eval-markets">
                {MARKET_CHOICES.map((symbol) => {
                  const checked = form.symbols.includes(symbol);
                  return (
                    <label key={symbol}>
                      <input
                        name="evaluation-market"
                        type="checkbox"
                        value={symbol}
                        checked={checked}
                        disabled={(!checked && form.symbols.length >= EVALUATION_MAX_MARKETS) || (checked && form.symbols.length === 1)}
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
              <label htmlFor={`${fieldId}-lookback`}>
                {t("serverEvalLookback")}
                <input
                  id={`${fieldId}-lookback`}
                  type="number"
                  min={EVALUATION_LOOKBACK_MIN_BARS}
                  max={EVALUATION_LOOKBACK_MAX_BARS}
                  step={100}
                  required
                  value={form.lookbackBars}
                  onChange={(event) => setForm((current) => ({ ...current, lookbackBars: boundedInteger(event.target.valueAsNumber, EVALUATION_LOOKBACK_MIN_BARS, EVALUATION_LOOKBACK_MAX_BARS) }))}
                />
              </label>
              <label htmlFor={`${fieldId}-train`}>
                {t("serverEvalTrainFraction")}
                <input
                  id={`${fieldId}-train`}
                  type="number"
                  min={EVALUATION_TRAIN_FRACTION_MIN}
                  max={EVALUATION_TRAIN_FRACTION_MAX}
                  step={0.05}
                  required
                  value={form.trainFraction}
                  onChange={(event) => setForm((current) => ({ ...current, trainFraction: boundedFraction(event.target.valueAsNumber) }))}
                />
              </label>
              <label htmlFor={`${fieldId}-embargo`}>
                {t("serverEvalEmbargo")}
                <input
                  id={`${fieldId}-embargo`}
                  type="number"
                  min={EVALUATION_EMBARGO_MIN_BARS}
                  max={EVALUATION_EMBARGO_MAX_BARS}
                  step={1}
                  required
                  value={form.embargoBars}
                  onChange={(event) => setForm((current) => ({ ...current, embargoBars: boundedInteger(event.target.valueAsNumber, EVALUATION_EMBARGO_MIN_BARS, EVALUATION_EMBARGO_MAX_BARS) }))}
                />
              </label>
            </div>
            <div className="strategy-generator-actions">
              <button type="submit" className="primary" disabled={!canSubmit}>
                {selectedActive ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <ServerCog size={15} aria-hidden="true" />}
                {selectedJob?.phase === "submitting" ? t("serverEvalSubmitting") : t("serverEvalSubmit")}
              </button>
            </div>
            {!selected?.validation.valid && <p className="strategy-generator-eval-hint" role="status">{t("serverEvalSelectValid")}</p>}
            {selected?.validation.valid && selectedActive && <p className="strategy-generator-eval-hint" role="status">{t("serverEvalBusy")}</p>}
            {activeCount >= MAX_ACTIVE_EVALUATIONS && <p className="strategy-generator-eval-hint" role="status">{t("serverEvalQuotaHint")}</p>}
          </form>
        )}
        {jobEntries.length > 0 && (
          <ul className="strategy-generator-eval-jobs" aria-label={t("serverEvalJobs")}>
            {jobEntries.map(([fingerprint, job]) => (
              <li key={fingerprint} data-eval-phase={job.phase}>
                <span className="strategy-generator-candidate-name">
                  <span>{candidateNames.get(fingerprint) ?? job.candidateName}</span>
                  <code title={fingerprint}>{fingerprint.slice(0, 24)}…</code>
                </span>
                <span className={`strategy-generator-eval-state is-${job.phase}`} role="status" aria-live="polite">
                  {t(PHASE_TEXT[job.phase])}{job.message ? ` · ${job.message}` : ""}
                </span>
                {isActivePhase(job.phase) && (
                  <button type="button" onClick={() => cancelJob(fingerprint)} aria-label={`${t("serverEvalCancelJob")}: ${job.candidateName}`}>
                    {t("serverEvalCancelJob")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="strategy-generator-ranking" data-ranking-state={ranking.ranked.length ? "ranked" : "unavailable"} aria-labelledby={rankingId}>
        <strong id={rankingId}>{t("ranking")}</strong>
        {ranking.ranked.length === 0 ? (
          <>
            <p>{t("rankingUnavailable")}</p>
            <p>{t("rankingNext")}</p>
          </>
        ) : (
          <>
            <p>{t("rankingRankedIntro")}</p>
            <ol className="strategy-generator-ranked-list">
              {ranking.ranked.map((entry, index) => {
                const stored = ranking.provenance.get(entry.candidateFingerprint);
                return (
                  <li key={entry.candidateFingerprint} data-candidate-fingerprint={entry.candidateFingerprint}>
                    <div className="strategy-generator-ranked-head">
                      <strong>#{index + 1} · {candidateNames.get(entry.candidateFingerprint) ?? entry.candidateFingerprint.slice(0, 16)}</strong>
                      <span className={entry.validation.valid ? "valid" : "invalid"}>{entry.validation.valid ? t("valid") : t("invalid")}</span>
                      <span>{t("rankingScore")}: <strong>{scoreText(entry.score)}</strong></span>
                    </div>
                    <dl>
                      <div><dt>{t("rankingMedian")}</dt><dd>{scoreText(entry.aggregate.median)}</dd></div>
                      <div><dt>{t("rankingWorst")}</dt><dd>{scoreText(entry.aggregate.worstMarket)}</dd></div>
                      <div><dt>{t("rankingDispersionPenalty")}</dt><dd>−{scoreText(entry.aggregate.dispersionPenalty)}</dd></div>
                      <div><dt>{t("rankingLosingPenalty")}</dt><dd>−{scoreText(entry.aggregate.losingMarketPenalty)}</dd></div>
                    </dl>
                    <details>
                      <summary>{t("rankingMarketBreakdown")}</summary>
                      <ul>
                        {entry.marketScores.map((market) => (
                          <li key={market.marketId}>
                            <code>{market.marketId}</code> · {t("rankingTrainScore")} {scoreText(market.trainScore)} · {t("rankingOosScore")} {scoreText(market.outOfSampleScore)} · {t("rankingGeneralizationPenalty")} −{scoreText(market.generalizationPenalty)} · {t("rankingOosLossPenalty")} −{scoreText(market.outOfSampleLossPenalty)} · {t("rankingScore")} {scoreText(market.total)}
                          </li>
                        ))}
                      </ul>
                      {!entry.validation.valid && <p className="invalid">{t("rankingChecks")}: {entry.validation.issues.join(", ")}</p>}
                    </details>
                    {stored && (
                      <p className="strategy-generator-ranked-provenance">
                        {t("engine")}: <code>{stored.engineVersion}</code> · {t("seed")}: {stored.seed} · {t("rankingDataset")}: <code className="strategy-generator-dataset-fingerprint">{stored.datasetFingerprint}</code>
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>
    </>
  );
}

function isActivePhase(phase: EvaluationJobPhase): boolean {
  return phase === "submitting" || phase === "queued" || phase === "running";
}

function failureText(t: Translate, error: unknown): string {
  if (error instanceof EvaluationApiError) {
    if (error.code === "job_quota_exceeded") return t("serverEvalQuotaError");
    if (error.code === "run_timeout") return t("serverEvalTimeoutError");
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function boundedFraction(value: number): number {
  if (!Number.isFinite(value)) return EVALUATION_DEFAULT_TRAIN_FRACTION;
  const bounded = Math.min(EVALUATION_TRAIN_FRACTION_MAX, Math.max(EVALUATION_TRAIN_FRACTION_MIN, value));
  return Math.round(bounded * 100) / 100;
}
