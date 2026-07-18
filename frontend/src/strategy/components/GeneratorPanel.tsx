import { CheckCircle2, Dna, Loader2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { localeTag } from "../../i18n";
import { useModalFocus } from "../../hooks/useModalFocus";
import {
  GENERATOR_LIMITS,
  StrategyGenerationAbortedError,
  generateStrategyCandidates,
  type GeneratedStrategyCandidate,
  type GeneratorProgress,
  type StrategyFamily,
  type StrategyGenerationResult,
  type TradeDirection
} from "../generator";
import { generatedCandidateToPortableArtifact } from "../generatedArtifact";
import { generatorText } from "../generatorText";
import type { PortableStrategyArtifact } from "../strategyFile";
import { GeneratorServerEvaluation } from "./GeneratorServerEvaluation";

const FAMILY_CHOICES: readonly StrategyFamily[] = ["trend", "mean-reversion", "breakout", "momentum"];
const DIRECTION_CHOICES: readonly TradeDirection[] = ["long", "short"];
const PAGE_SIZE = 25;
const MAX_SEED = 0xffff_ffff;

type GenerateCandidates = typeof generateStrategyCandidates;

interface GeneratorPanelProps {
  locale: Locale;
  onClose: () => void;
  onImport: (artifact: PortableStrategyArtifact) => void;
  generateCandidates?: GenerateCandidates;
  /** Authenticated owner id; enables server multi-market evaluation jobs. */
  ownerUserId?: string;
}

interface GeneratorFormState {
  families: StrategyFamily[];
  directions: TradeDirection[];
  seed: number;
  populationSize: number;
  generations: number;
}

const DEFAULT_FORM: GeneratorFormState = {
  families: [...FAMILY_CHOICES],
  directions: [...DIRECTION_CHOICES],
  seed: 42,
  populationSize: 16,
  generations: 3
};

export function GeneratorPanel({ locale, onClose, onImport, generateCandidates = generateStrategyCandidates, ownerUserId }: GeneratorPanelProps) {
  const t = (key: Parameters<typeof generatorText>[1]) => generatorText(locale, key);
  const [form, setForm] = useState<GeneratorFormState>(DEFAULT_FORM);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<GeneratorProgress>();
  const [result, setResult] = useState<StrategyGenerationResult>();
  const [selectedFingerprint, setSelectedFingerprint] = useState<string>();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const controllerRef = useRef<AbortController>();
  const mountedRef = useRef(true);
  const titleId = useId();
  const introId = useId();
  const progressId = useId();
  const modal = useModalFocus<HTMLDivElement>(handleClose, "input");
  const candidates = result?.candidates ?? [];
  const pages = Math.max(1, Math.ceil(candidates.length / PAGE_SIZE));
  const visibleCandidates = candidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = useMemo(() => candidates.find((candidate) => candidate.fingerprint === selectedFingerprint), [candidates, selectedFingerprint]);
  const maxGenerations = maxGenerationsForPopulation(form.populationSize);
  const formatter = useMemo(() => new Intl.NumberFormat(localeTag(locale)), [locale]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  function handleClose() {
    controllerRef.current?.abort();
    onClose();
  }

  const toggleChoice = <T extends string>(key: "families" | "directions", value: T) => {
    setForm((current) => {
      const values = current[key] as string[];
      if (values.includes(value) && values.length === 1) return current;
      const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
      return { ...current, [key]: next } as GeneratorFormState;
    });
  };

  const updatePopulation = (value: number) => {
    const populationSize = boundedInteger(value, GENERATOR_LIMITS.minPopulation, GENERATOR_LIMITS.maxPopulation);
    setForm((current) => ({
      ...current,
      populationSize,
      generations: Math.min(current.generations, maxGenerationsForPopulation(populationSize))
    }));
  };

  const startGeneration = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setCancelling(false);
    setResult(undefined);
    setSelectedFingerprint(undefined);
    setPage(0);
    setProgress(undefined);
    setStatus(undefined);
    setError(undefined);
    let lastAccepted = -1;
    let lastGeneration = -1;
    const updateEvery = Math.max(1, Math.ceil(form.populationSize / 4));
    try {
      const generated = await generateCandidates({
        seed: boundedInteger(form.seed, 0, MAX_SEED),
        populationSize: form.populationSize,
        generations: Math.min(form.generations, maxGenerationsForPopulation(form.populationSize)),
        families: form.families,
        directions: form.directions
      }, {
        signal: controller.signal,
        onProgress: (next) => {
          if (!mountedRef.current || controllerRef.current !== controller) return;
          if (next.generation !== lastGeneration || next.accepted === next.targetCandidates || next.accepted - lastAccepted >= updateEvery) {
            lastAccepted = next.accepted;
            lastGeneration = next.generation;
            setProgress(next);
          }
        }
      });
      if (!mountedRef.current || controllerRef.current !== controller) return;
      setResult(generated);
      setSelectedFingerprint(generated.candidates.find((candidate) => candidate.validation.valid)?.fingerprint);
      if (generated.exhausted) setStatus(t("exhausted"));
    } catch (caught) {
      if (!mountedRef.current || controllerRef.current !== controller) return;
      if (caught instanceof StrategyGenerationAbortedError || (caught instanceof Error && caught.name === "AbortError")) setStatus(t("cancelled"));
      else setError(`${t("failed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      if (mountedRef.current && controllerRef.current === controller) {
        controllerRef.current = undefined;
        setRunning(false);
        setCancelling(false);
      }
    }
  };

  const cancelGeneration = () => {
    if (!controllerRef.current) return;
    setCancelling(true);
    controllerRef.current.abort();
  };

  const importSelected = () => {
    if (!selected?.validation.valid) return;
    try {
      onImport(generatedCandidateToPortableArtifact(selected, t("artifactDescription")));
    } catch {
      setError(t("importFailed"));
    }
  };

  return (
    <div
      ref={modal.dialogRef}
      tabIndex={-1}
      className="gallery-backdrop strategy-generator-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={introId}
      onKeyDown={modal.onKeyDown}
      onPointerDown={(event) => { if (event.target === event.currentTarget) handleClose(); }}
    >
      <section className="strategy-generator-dialog">
        <header className="gallery-head">
          <div>
            <strong id={titleId}><Dna size={17} aria-hidden="true" /> {t("title")}</strong>
            <p id={introId}>{t("intro")}</p>
          </div>
          <button type="button" className="icon-button" onClick={handleClose} aria-label={t("close")}><X size={16} aria-hidden="true" /></button>
        </header>

        <div className="strategy-generator-body">
          <form className="strategy-generator-form" onSubmit={(event) => { event.preventDefault(); void startGeneration(); }}>
            <fieldset>
              <legend>{t("scope")}</legend>
              <div className="strategy-generator-scope">
                <fieldset>
                  <legend>{t("families")}</legend>
                  {FAMILY_CHOICES.map((family) => (
                    <label key={family}>
                      <input
                        name="generator-family"
                        type="checkbox"
                        value={family}
                        checked={form.families.includes(family)}
                        disabled={running || (form.families.length === 1 && form.families[0] === family)}
                        onChange={() => toggleChoice("families", family)}
                      />
                      {familyText(t, family)}
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>{t("directions")}</legend>
                  {DIRECTION_CHOICES.map((direction) => (
                    <label key={direction}>
                      <input
                        name="generator-direction"
                        type="checkbox"
                        value={direction}
                        checked={form.directions.includes(direction)}
                        disabled={running || (form.directions.length === 1 && form.directions[0] === direction)}
                        onChange={() => toggleChoice("directions", direction)}
                      />
                      {t(direction)}
                    </label>
                  ))}
                </fieldset>
              </div>
            </fieldset>

            <fieldset>
              <legend>{t("settings")}</legend>
              <div className="strategy-generator-number-fields">
                <label>{t("seed")}<input name="generator-seed" type="number" min={0} max={MAX_SEED} step={1} required disabled={running} value={form.seed} onChange={(event) => setForm((current) => ({ ...current, seed: boundedInteger(event.target.valueAsNumber, 0, MAX_SEED) }))} /></label>
                <label>{t("population")}<input name="generator-population" type="number" min={GENERATOR_LIMITS.minPopulation} max={GENERATOR_LIMITS.maxPopulation} step={1} required disabled={running} value={form.populationSize} onChange={(event) => updatePopulation(event.target.valueAsNumber)} /></label>
                <label>{t("generations")}<input name="generator-generations" type="number" min={0} max={maxGenerations} step={1} required disabled={running} value={form.generations} onChange={(event) => setForm((current) => ({ ...current, generations: boundedInteger(event.target.valueAsNumber, 0, maxGenerationsForPopulation(current.populationSize)) }))} /></label>
              </div>
              <p>{t("budgetHint")}</p>
            </fieldset>

            <div className="strategy-generator-actions">
              <button type="submit" className="primary" disabled={running}>{running ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Dna size={15} aria-hidden="true" />}{running ? t("running") : t("start")}</button>
              {running && <button type="button" onClick={cancelGeneration} disabled={cancelling}>{cancelling ? t("cancelling") : t("cancel")}</button>}
            </div>
          </form>

          {(running || progress) && (
            <section className="strategy-generator-progress" aria-labelledby={progressId}>
              <strong id={progressId}>{t("progress")}</strong>
              <progress max={Math.max(1, progress?.targetCandidates ?? form.populationSize * (form.generations + 1))} value={progress?.accepted ?? 0} />
              <p role="status" aria-live="polite">
                {t("generation")} {progress?.generation ?? 0}/{progress?.generations ?? form.generations} · {formatter.format(progress?.accepted ?? 0)} {t("accepted")} / {formatter.format(progress?.targetCandidates ?? form.populationSize * (form.generations + 1))} {t("target")} · {formatter.format(progress?.attempts ?? 0)} {t("attempts")} · {formatter.format(progress?.duplicates ?? 0)} {t("duplicates")}
              </p>
            </section>
          )}

          {status && <p className="strategy-generator-status" role="status" aria-live="polite">{status}</p>}
          {error && <p className="strategy-generator-error" role="alert">{error}</p>}

          <section className="strategy-generator-results" aria-labelledby={`${titleId}-results`}>
            <div className="panel-header">
              <strong id={`${titleId}-results`}>{t("results")}</strong>
              <span>{formatter.format(candidates.length)}</span>
            </div>
            <p>{candidates.length ? t("resultSummary") : t("noCandidates")}</p>
            {candidates.length > 0 && (
              <>
                <div className="strategy-generator-table-wrap">
                  <table>
                    <thead><tr><th scope="col">{t("select")}</th><th scope="col">{t("candidate")}</th><th scope="col">{t("family")}</th><th scope="col">{t("direction")}</th><th scope="col">{t("provenance")}</th><th scope="col">{t("validation")}</th></tr></thead>
                    <tbody>
                      {visibleCandidates.map((candidate) => (
                        <CandidateRow key={candidate.fingerprint} candidate={candidate} selected={candidate.fingerprint === selectedFingerprint} onSelect={setSelectedFingerprint} t={t} />
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <nav className="strategy-generator-pagination" aria-label={t("results")}>
                    <button type="button" aria-label={t("previousPage")} disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>‹</button>
                    <span>{t("page")} {page + 1}/{pages}</span>
                    <button type="button" aria-label={t("nextPage")} disabled={page + 1 >= pages} onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}>›</button>
                  </nav>
                )}
              </>
            )}
          </section>

          {selected && <CandidateEvidence candidate={selected} t={t} />}

          {candidates.length > 0 ? (
            <GeneratorServerEvaluation
              locale={locale}
              ownerUserId={ownerUserId}
              candidates={candidates}
              selected={selected}
              seed={form.seed}
              t={t}
            />
          ) : (
            <section className="strategy-generator-ranking" data-ranking-state="unavailable">
              <strong>{t("ranking")}</strong>
              <p>{t("rankingUnavailable")}</p>
              <p>{t("rankingNext")}</p>
            </section>
          )}
        </div>

        <footer className="strategy-generator-footer">
          <p>{t("importHelp")}</p>
          <button type="button" className="primary" disabled={!selected?.validation.valid || running} onClick={importSelected}><CheckCircle2 size={15} aria-hidden="true" /> {t("import")}</button>
        </footer>
      </section>
    </div>
  );
}

function CandidateRow({ candidate, selected, onSelect, t }: { candidate: GeneratedStrategyCandidate; selected: boolean; onSelect: (fingerprint: string) => void; t: (key: Parameters<typeof generatorText>[1]) => string }) {
  const checks = Object.values(candidate.validation.flags);
  return (
    <tr className={selected ? "selected" : undefined}>
      <td><input type="radio" name="generated-candidate" checked={selected} onChange={() => onSelect(candidate.fingerprint)} aria-label={`${t("select")}: ${candidate.ir.name} · ${candidate.fingerprint}`} /></td>
      <th scope="row"><span className="strategy-generator-candidate-name"><span>{candidate.ir.name}</span><code title={candidate.fingerprint}>{candidate.fingerprint.slice(0, 24)}…</code></span></th>
      <td>{familyText(t, candidate.genome.signal.family)}</td>
      <td>{t(candidate.genome.direction)}</td>
      <td>{t("generation")} {candidate.provenance.generation} · {originText(t, candidate.provenance.origin)}</td>
      <td className={candidate.validation.valid ? "valid" : "invalid"}>{candidate.validation.valid ? t("valid") : t("invalid")} · {checks.filter(Boolean).length}/{checks.length}</td>
    </tr>
  );
}

function CandidateEvidence({ candidate, t }: { candidate: GeneratedStrategyCandidate; t: (key: Parameters<typeof generatorText>[1]) => string }) {
  return (
    <details className="strategy-generator-evidence" open>
      <summary>{t("candidateDetails")}</summary>
      <dl>
        <div><dt>{t("fingerprint")}</dt><dd><code>{candidate.fingerprint}</code></dd></div>
        <div><dt>{t("engine")}</dt><dd>{candidate.provenance.engine}</dd></div>
        <div><dt>{t("seed")}</dt><dd>{candidate.provenance.seed}</dd></div>
        <div><dt>{t("generation")}</dt><dd>{candidate.provenance.generation} · {originText(t, candidate.provenance.origin)}</dd></div>
        <div><dt>{t("parents")}</dt><dd>{candidate.provenance.parentFingerprints.length ? candidate.provenance.parentFingerprints.map((fingerprint) => <code key={fingerprint}>{fingerprint}</code>) : t("none")}</dd></div>
        <div><dt>{t("mutations")}</dt><dd>{candidate.provenance.mutationLog.length ? candidate.provenance.mutationLog.map((mutation, index) => <code key={`${mutation.field}-${index}`}>{mutation.field}: {String(mutation.from)} → {String(mutation.to)}</code>) : t("none")}</dd></div>
        <div><dt>{t("validationChecks")}</dt><dd>{Object.entries(candidate.validation.flags).map(([flag, passed]) => <span className={passed ? "valid" : "invalid"} key={flag}>{passed ? "✓" : "×"} {flag}</span>)}</dd></div>
      </dl>
    </details>
  );
}

function maxGenerationsForPopulation(populationSize: number): number {
  return Math.max(0, Math.min(GENERATOR_LIMITS.maxGenerations, Math.floor(GENERATOR_LIMITS.maxCandidates / populationSize) - 1));
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function familyText(t: (key: Parameters<typeof generatorText>[1]) => string, family: StrategyFamily): string {
  if (family === "mean-reversion") return t("meanReversion");
  return t(family);
}

function originText(t: (key: Parameters<typeof generatorText>[1]) => string, origin: GeneratedStrategyCandidate["provenance"]["origin"]): string {
  if (origin === "seed") return t("originSeed");
  if (origin === "mutation") return t("originMutation");
  if (origin === "crossover") return t("originCrossover");
  return t("originCrossoverMutation");
}
