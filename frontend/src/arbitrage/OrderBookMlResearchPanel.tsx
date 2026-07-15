import { AlertTriangle, BrainCircuit, Database, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { createOrderBookMlResearchSession, deleteOrderBookMlResearchSession, fetchOrderBookMlResearchStatus, OrderBookMlResearchApiError, predictOrderBookMlResearchModel, trainOrderBookMlResearchModel, uploadOrderBookMlResearchSnapshots } from "./orderBookMlResearchClient";
import { MAX_RESEARCH_JSON_CHARACTERS, parseResearchSnapshotBatchJson } from "./orderBookMlResearchParsers";
import { MetricsTable, PredictionResult } from "./OrderBookMlResearchResults";
import { orderBookMlResearchText as t } from "./orderBookMlResearchText";
import { ORDER_BOOK_QUALITY_POLICY_SCHEMA, type ResearchPredictionResult, type ResearchSession, type ResearchStatus, type ResearchTrainingResult } from "./orderBookMlResearchTypes";

interface Props {
  locale: Locale;
}

type BusyAction = "refresh" | "create" | "delete" | "upload" | "train" | "predict";
interface UiError {
  message: string;
  code?: string;
}

export function OrderBookMlResearchPanel({ locale }: Props) {
  const [registry, setRegistry] = useState<ResearchStatus>();
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [uploadJson, setUploadJson] = useState("");
  const [inferenceJson, setInferenceJson] = useState("");
  const [lastTraining, setLastTraining] = useState<ResearchTrainingResult>();
  const [prediction, setPrediction] = useState<ResearchPredictionResult>();
  const [busy, setBusy] = useState<BusyAction>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError>();
  const activeRequest = useRef<AbortController>();
  const errorRef = useRef<HTMLDivElement>(null);

  const selectedSession = registry?.sessions.find((session) => session.id === selectedSessionId);
  const selectedModel = selectedSession?.models.find((model) => model.modelId === selectedModelId);
  const modelIdentity = selectedSession?.models.map((model) => model.modelId).join("|") ?? "";

  useEffect(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy("refresh");
    void fetchOrderBookMlResearchStatus(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          applyRegistry(value);
          setBusy(undefined);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(toUiError(cause, locale, "statusUnavailable"));
          setBusy(undefined);
        }
      });
    return () => controller.abort();
  }, [locale]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!selectedSession) {
      setPrediction(undefined);
      setSelectedModelId("");
      return;
    }
    if (!selectedSession.models.some((model) => model.modelId === selectedModelId)) {
      setPrediction(undefined);
      setSelectedModelId(selectedSession.models[0]?.modelId ?? "");
    }
  }, [modelIdentity, selectedModelId, selectedSession]);

  function applyRegistry(value: ResearchStatus, preferredSessionId?: string) {
    setRegistry(value);
    setSelectedSessionId((current) => {
      if (value.sessions.some((session) => session.id === preferredSessionId)) return preferredSessionId!;
      if (value.sessions.some((session) => session.id === current)) return current;
      return value.sessions[0]?.id ?? "";
    });
  }

  async function run(action: BusyAction, operation: (signal: AbortSignal) => Promise<void>) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(action);
    setError(undefined);
    setNotice("");
    try {
      await operation(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(toUiError(cause, locale));
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  function refresh() {
    void run("refresh", async (signal) => applyRegistry(await fetchOrderBookMlResearchStatus(signal)));
  }

  function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void run("create", async (signal) => {
      const name = stringValue(values, "name").trim();
      const created = await createOrderBookMlResearchSession(
        {
          ...(name ? { name } : {}),
          qualityPolicy: {
            schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA,
            maximumAgeMs: numberValue(values, "maximumAgeMs"),
            maximumFutureSkewMs: numberValue(values, "maximumFutureSkewMs"),
            maximumInputDepth: numberValue(values, "maximumInputDepth"),
            normalizedDepth: numberValue(values, "normalizedDepth")
          },
          labelPolicy: { horizonsMs: horizons(stringValue(values, "horizonsMs")), maximumAlignmentDelayMs: numberValue(values, "maximumAlignmentDelayMs") }
        },
        signal
      );
      applyRegistry(await fetchOrderBookMlResearchStatus(signal), created.id);
      setNotice(t(locale, "createdNotice"));
      form.reset();
    });
  }

  function deleteSession(session: ResearchSession) {
    void run("delete", async (signal) => {
      const result = await deleteOrderBookMlResearchSession(session.id, signal);
      applyRegistry(await fetchOrderBookMlResearchStatus(signal));
      setDeleteArmed(false);
      setPrediction(undefined);
      setLastTraining(undefined);
      setNotice(t(locale, "deletedNotice", { count: String(result.ephemeralArtifactsDeleted) }));
    });
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession) return;
    void run("upload", async (signal) => {
      const result = await uploadOrderBookMlResearchSnapshots(selectedSession.id, parseResearchSnapshotBatchJson(uploadJson), signal);
      applyRegistry(await fetchOrderBookMlResearchStatus(signal), selectedSession.id);
      setUploadJson("");
      setNotice(t(locale, "uploadedNotice", { count: String(result.accepted), total: String(result.totalSnapshots) }));
    });
  }

  function train(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession) return;
    const values = new FormData(event.currentTarget);
    setPrediction(undefined);
    void run("train", async (signal) => {
      const result = await trainOrderBookMlResearchModel(
        selectedSession.id,
        {
          horizonMs: numberValue(values, "horizonMs"),
          minimumRowsPerSplit: numberValue(values, "minimumRowsPerSplit"),
          ...optionalNumber(values, "ridgeLambda"),
          ...optionalNumber(values, "trainFraction"),
          ...optionalNumber(values, "validationFraction"),
          ...optionalNumber(values, "flatThresholdBps"),
          ...optionalNumber(values, "outOfDistributionZScore")
        },
        signal
      );
      setLastTraining(result);
      setSelectedModelId(result.model.modelId);
      applyRegistry(await fetchOrderBookMlResearchStatus(signal), selectedSession.id);
      setNotice(t(locale, "trainedNotice"));
    });
  }

  function predict(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession || !selectedModelId) return;
    setPrediction(undefined);
    void run("predict", async (signal) => {
      const result = await predictOrderBookMlResearchModel(selectedSession.id, selectedModelId, parseResearchSnapshotBatchJson(inferenceJson, 2), signal);
      setPrediction(result);
      applyRegistry(await fetchOrderBookMlResearchStatus(signal), selectedSession.id);
      setNotice(t(locale, "predictionNotice"));
    });
  }

  return (
    <section className="arb-screener obml-research" aria-labelledby="obml-title" aria-busy={Boolean(busy)}>
      <header className="arb-hero obml-header">
        <div>
          <span className="arb-eyebrow">
            <BrainCircuit size={14} aria-hidden="true" />
            {t(locale, "eyebrow")}
          </span>
          <h1 id="obml-title">{t(locale, "title")}</h1>
          <p>{t(locale, "description")}</p>
        </div>
        <button type="button" className="arb-refresh" onClick={refresh} disabled={Boolean(busy)}>
          <RefreshCw size={15} aria-hidden="true" />
          {t(locale, "refresh")}
        </button>
      </header>

      <aside className="obml-boundary" aria-labelledby="obml-boundary-title">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <h2 id="obml-boundary-title">{t(locale, "safetyTitle")}</h2>
          <ul>
            <li>{t(locale, "safetyAnonymous")}</li>
            <li>{t(locale, "safetyNoProbability")}</li>
            <li>{t(locale, "safetyNoExecution")}</li>
            <li>{t(locale, "safetyUploadOnly")}</li>
          </ul>
        </div>
      </aside>

      {error && (
        <div ref={errorRef} className="arb-notice danger obml-error" role="alert" tabIndex={-1}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {error.message}
            {error.code && <code>{error.code}</code>}
          </span>
        </div>
      )}
      {notice && (
        <p className="arb-notice info" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {busy && (
        <p className="sr-only" role="status" aria-live="polite">
          {t(locale, busy === "refresh" ? "loading" : "busy")}
        </p>
      )}

      {registry ? (
        <>
          <RegistrySummary locale={locale} status={registry} />
          <div className="obml-session-grid">
            <CreateSessionForm locale={locale} busy={busy} onSubmit={createSession} />
            <SessionPicker
              locale={locale}
              sessions={registry.sessions}
              selectedId={selectedSessionId}
              busy={busy}
              deleteArmed={deleteArmed}
              onSelect={(id) => {
                setSelectedSessionId(id);
                setDeleteArmed(false);
                setPrediction(undefined);
                setLastTraining(undefined);
              }}
              onArmDelete={setDeleteArmed}
              onDelete={deleteSession}
            />
          </div>
          {selectedSession && (
            <>
              <SessionEvidence locale={locale} session={selectedSession} />
              <div className="obml-operation-grid">
                <form className="obml-card obml-json-form" onSubmit={upload}>
                  <fieldset disabled={Boolean(busy)}>
                    <legend>{t(locale, "uploadTitle")}</legend>
                    <p>{t(locale, "uploadHint")}</p>
                    <label htmlFor="obml-upload-json">{t(locale, "snapshotJson")}</label>
                    <textarea id="obml-upload-json" name="snapshots" rows={10} maxLength={MAX_RESEARCH_JSON_CHARACTERS} spellCheck={false} required value={uploadJson} onChange={(event) => setUploadJson(event.target.value)} />
                    <button type="submit">{t(locale, busy === "upload" ? "uploading" : "upload")}</button>
                  </fieldset>
                </form>
                <TrainingForm key={selectedSession.id} locale={locale} session={selectedSession} busy={busy} onSubmit={train} />
              </div>
              <ModelRegistry
                locale={locale}
                session={selectedSession}
                selectedModelId={selectedModelId}
                lastTraining={lastTraining}
                onSelect={(modelId) => {
                  setPrediction(undefined);
                  setSelectedModelId(modelId);
                }}
              />
              <form className="obml-card obml-json-form" onSubmit={predict}>
                <fieldset disabled={Boolean(busy) || !selectedModel}>
                  <legend>{t(locale, "predictionTitle")}</legend>
                  <p>{t(locale, "predictionHint")}</p>
                  <label htmlFor="obml-inference-json">{t(locale, "inferenceJson")}</label>
                  <textarea id="obml-inference-json" name="snapshots" rows={8} maxLength={MAX_RESEARCH_JSON_CHARACTERS} spellCheck={false} required value={inferenceJson} onChange={(event) => setInferenceJson(event.target.value)} />
                  <button type="submit">{t(locale, busy === "predict" ? "predicting" : "predict")}</button>
                </fieldset>
              </form>
              {prediction && <PredictionResult locale={locale} result={prediction} />}
            </>
          )}
        </>
      ) : !error ? (
        <p className="obml-loading" role="status">
          {t(locale, "loading")}
        </p>
      ) : null}
    </section>
  );
}

function RegistrySummary({ locale, status }: { locale: Locale; status: ResearchStatus }) {
  const { health } = status;
  return (
    <section className="obml-card" aria-labelledby="obml-registry-title">
      <div className="obml-section-heading">
        <Database size={18} aria-hidden="true" />
        <h2 id="obml-registry-title">{t(locale, "serviceStatus")}</h2>
      </div>
      <dl className="obml-stat-grid">
        <Stat label={t(locale, "sessions")} value={health.registry.sessions} />
        <Stat label={t(locale, "snapshots")} value={health.registry.snapshots} />
        <Stat label={t(locale, "models")} value={health.registry.models} />
      </dl>
      <p>{t(locale, "limit", { sessions: String(health.limits.maxSessions), snapshots: String(health.limits.maxSnapshotsPerSession), models: String(health.limits.maxModelsPerSession), ttl: String(Math.round(health.limits.sessionTtlMs / 60_000)) })}</p>
      <small>{t(locale, "storage")}</small>
    </section>
  );
}

function CreateSessionForm({ locale, busy, onSubmit }: { locale: Locale; busy?: BusyAction; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return (
    <form className="obml-card obml-form" onSubmit={onSubmit}>
      <fieldset disabled={Boolean(busy)}>
        <legend>{t(locale, "createSession")}</legend>
        <label htmlFor="obml-name">{t(locale, "name")}</label>
        <input id="obml-name" name="name" maxLength={80} aria-describedby="obml-name-hint" />
        <small id="obml-name-hint">{t(locale, "nameHint")}</small>
        <fieldset>
          <legend>{t(locale, "labelPolicy")}</legend>
          <label htmlFor="obml-horizons">{t(locale, "horizons")}</label>
          <input id="obml-horizons" name="horizonsMs" defaultValue="1000" required aria-describedby="obml-horizons-hint" />
          <small id="obml-horizons-hint">{t(locale, "horizonsHint")}</small>
          <NumberField id="obml-alignment" name="maximumAlignmentDelayMs" label={t(locale, "alignment")} value={250} min={0} max={60_000} />
        </fieldset>
        <fieldset>
          <legend>{t(locale, "qualityPolicy")}</legend>
          <div className="obml-field-grid">
            <NumberField id="obml-max-age" name="maximumAgeMs" label={t(locale, "maximumAge")} value={5_000} min={0} max={60_000} />
            <NumberField id="obml-future-skew" name="maximumFutureSkewMs" label={t(locale, "futureSkew")} value={500} min={0} max={5_000} />
            <NumberField id="obml-input-depth" name="maximumInputDepth" label={t(locale, "inputDepth")} value={50} min={10} max={100} />
            <NumberField id="obml-normalized-depth" name="normalizedDepth" label={t(locale, "normalizedDepth")} value={10} min={10} max={100} />
          </div>
        </fieldset>
        <button type="submit">{t(locale, busy === "create" ? "creating" : "create")}</button>
      </fieldset>
    </form>
  );
}

function SessionPicker(props: { locale: Locale; sessions: ResearchSession[]; selectedId: string; busy?: BusyAction; deleteArmed: boolean; onSelect(id: string): void; onArmDelete(value: boolean): void; onDelete(session: ResearchSession): void }) {
  const selected = props.sessions.find((session) => session.id === props.selectedId);
  return (
    <section className="obml-card">
      <fieldset className="obml-session-picker" disabled={Boolean(props.busy)}>
        <legend>{t(props.locale, "selectSession")}</legend>
        {props.sessions.length ? (
          props.sessions.map((session) => (
            <label key={session.id}>
              <input type="radio" name="obml-session" value={session.id} checked={session.id === props.selectedId} onChange={() => props.onSelect(session.id)} />
              <span>
                <strong>{session.name ?? shortId(session.id)}</strong>
                <small>
                  {session.snapshotCount} {t(props.locale, "snapshots").toLocaleLowerCase()} · {session.models.length} {t(props.locale, "models").toLocaleLowerCase()} · {t(props.locale, "expires", { time: date(props.locale, session.expiresAt) })}
                </small>
              </span>
            </label>
          ))
        ) : (
          <p>{t(props.locale, "noSessions")}</p>
        )}
      </fieldset>
      {selected &&
        (!props.deleteArmed ? (
          <button type="button" className="obml-danger-button" disabled={Boolean(props.busy)} onClick={() => props.onArmDelete(true)}>
            <Trash2 size={14} aria-hidden="true" />
            {t(props.locale, "delete")}
          </button>
        ) : (
          <div className="obml-delete-confirm" role="group" aria-label={t(props.locale, "deletePrompt")}>
            <p>{t(props.locale, "deletePrompt")}</p>
            <button type="button" className="obml-danger-button" disabled={Boolean(props.busy)} onClick={() => props.onDelete(selected)}>
              {t(props.locale, props.busy === "delete" ? "deleting" : "confirmDelete")}
            </button>
            <button type="button" disabled={Boolean(props.busy)} onClick={() => props.onArmDelete(false)}>
              {t(props.locale, "cancel")}
            </button>
          </div>
        ))}
    </section>
  );
}

function SessionEvidence({ locale, session }: { locale: Locale; session: ResearchSession }) {
  const q = session.quality;
  return (
    <section className="obml-card" aria-labelledby="obml-evidence-title">
      <h2 id="obml-evidence-title">{t(locale, "sessionDetails")}</h2>
      <div className="obml-evidence-grid">
        <div>
          <h3>{t(locale, "provenance")}</h3>
          {session.provenance ? (
            <dl className="obml-details">
              <Pair label={t(locale, "venueMarket")} value={`${session.provenance.venue} / ${session.provenance.market}`} />
              <Pair label={t(locale, "instrument")} value={`${session.provenance.symbol} · ${session.provenance.instrumentId}`} />
              <Pair label={t(locale, "sequenceRange")} value={`${session.provenance.firstSequence} → ${session.provenance.lastSequence}`} />
              <Pair label={t(locale, "captureWindow")} value={`${date(locale, session.provenance.firstExchangeTs)} → ${date(locale, session.provenance.lastExchangeTs)}`} />
              <Pair label={t(locale, "normalizer")} value={`${session.provenance.normalizerVersion} · generation ${session.provenance.connectionGeneration}`} />
              <Pair label={t(locale, "checksum")} value={t(locale, session.provenance.checksumVerifiedForEverySnapshot ? "yes" : "no")} />
            </dl>
          ) : (
            <p>{t(locale, "noProvenance")}</p>
          )}
        </div>
        <div>
          <h3>{t(locale, "qualityCounters")}</h3>
          <dl className="obml-stat-grid obml-quality-stats">
            <Stat label={t(locale, "submitted")} value={q.submittedSnapshots} />
            <Stat label={t(locale, "accepted")} value={q.acceptedSnapshots} />
            <Stat label={t(locale, "rejected")} value={q.rejectedSnapshots} />
            <Stat label={t(locale, "discarded")} value={q.discardedSnapshots} />
            <Stat label={t(locale, "acceptedBatches")} value={q.acceptedBatches} />
            <Stat label={t(locale, "rejectedBatches")} value={q.rejectedBatches} />
          </dl>
          <strong>{t(locale, "issueCodes")}</strong>
          <p>
            {Object.entries(q.issuesByCode).length
              ? Object.entries(q.issuesByCode)
                  .map(([code, count]) => `${code}: ${count}`)
                  .join(" · ")
              : t(locale, "none")}
          </p>
        </div>
      </div>
    </section>
  );
}

function TrainingForm({ locale, session, busy, onSubmit }: { locale: Locale; session: ResearchSession; busy?: BusyAction; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return (
    <form className="obml-card obml-form" onSubmit={onSubmit}>
      <fieldset disabled={Boolean(busy) || session.snapshotCount === 0}>
        <legend>{t(locale, "trainTitle")}</legend>
        <p>{t(locale, "trainingConfig")}</p>
        <label htmlFor="obml-horizon">{t(locale, "horizon")}</label>
        <select id="obml-horizon" name="horizonMs" defaultValue={session.labelPolicy.horizonsMs[0]}>
          {session.labelPolicy.horizonsMs.map((value) => (
            <option key={value} value={value}>
              {value} ms
            </option>
          ))}
        </select>
        <div className="obml-field-grid">
          <NumberField id="obml-lambda" name="ridgeLambda" label={t(locale, "ridgeLambda")} value={0.1} min={0.000001} max={1_000_000} step="any" />
          <NumberField id="obml-train-fraction" name="trainFraction" label={t(locale, "trainFraction")} value={0.6} min={0.4} max={0.8} step={0.05} />
          <NumberField id="obml-validation-fraction" name="validationFraction" label={t(locale, "validationFraction")} value={0.2} min={0.1} max={0.3} step={0.05} />
          <NumberField id="obml-min-rows" name="minimumRowsPerSplit" label={t(locale, "minimumRows")} value={30} min={5} max={500} />
          <NumberField id="obml-flat-threshold" name="flatThresholdBps" label={t(locale, "flatThreshold")} value={0.05} min={0} max={1_000_000} step="any" />
          <NumberField id="obml-ood" name="outOfDistributionZScore" label={t(locale, "oodThreshold")} value={6} min={1} max={100} step="any" />
        </div>
        <button type="submit">{t(locale, busy === "train" ? "training" : "trainModel")}</button>
      </fieldset>
    </form>
  );
}

function ModelRegistry({ locale, session, selectedModelId, lastTraining, onSelect }: { locale: Locale; session: ResearchSession; selectedModelId: string; lastTraining?: ResearchTrainingResult; onSelect(id: string): void }) {
  const model = session.models.find((entry) => entry.modelId === selectedModelId);
  return (
    <section className="obml-card" aria-labelledby="obml-models-title">
      <h2 id="obml-models-title">{t(locale, "modelList")}</h2>
      {session.models.length ? (
        <>
          <fieldset className="obml-model-picker">
            <legend className="sr-only">{t(locale, "modelList")}</legend>
            {session.models.map((entry) => (
              <label key={entry.modelId}>
                <input type="radio" name="obml-model" checked={entry.modelId === selectedModelId} onChange={() => onSelect(entry.modelId)} aria-label={t(locale, "chooseModel", { id: shortModelId(entry.modelId) })} />
                <code title={entry.modelId}>{shortModelId(entry.modelId)}</code>
                <span>
                  {entry.target.horizonMs} ms · {date(locale, entry.trainedAt)}
                </span>
              </label>
            ))}
          </fieldset>
          {model && <MetricsTable locale={locale} model={model} />}
          {lastTraining?.model.modelId === selectedModelId && (
            <p>
              {t(locale, "purgedRows", { train: String(lastTraining.split.purgedTrainRows), validation: String(lastTraining.split.purgedValidationRows) })} · {t(locale, "dataset")}: {lastTraining.dataset.rows}
            </p>
          )}
        </>
      ) : (
        <p>{t(locale, "noModels")}</p>
      )}
    </section>
  );
}

function NumberField(props: { id: string; name: string; label: string; value: number; min: number; max: number; step?: number | "any" }) {
  return (
    <label htmlFor={props.id}>
      {props.label}
      <input id={props.id} name={props.name} type="number" defaultValue={props.value} min={props.min} max={props.max} step={props.step ?? 1} required />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function date(locale: Locale, value: number) {
  return new Date(value).toLocaleString(localeTag(locale));
}
function shortId(value: string) {
  return `${value.slice(0, 8)}…`;
}
function shortModelId(value: string) {
  return `${value.slice(0, 17)}…${value.slice(-6)}`;
}
function stringValue(values: FormData, name: string) {
  const value = values.get(name);
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}
function numberValue(values: FormData, name: string) {
  const value = Number(stringValue(values, name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}
function optionalNumber(values: FormData, name: "ridgeLambda" | "trainFraction" | "validationFraction" | "flatThresholdBps" | "outOfDistributionZScore") {
  const raw = stringValue(values, name).trim();
  return raw ? { [name]: numberValue(values, name) } : {};
}
function horizons(value: string) {
  return value.split(",").map((entry) => Number(entry.trim()));
}
function toUiError(cause: unknown, locale: Locale, fallback: "operationFailed" | "statusUnavailable" = "operationFailed"): UiError {
  if (cause instanceof OrderBookMlResearchApiError) {
    if (cause.status === 401) return { message: t(locale, "authRequired"), code: cause.code };
    if (cause.status === 403 || cause.code === "admin-required") return { message: t(locale, "adminRequired"), code: cause.code };
    if ([400, 409, 413, 422].includes(cause.status)) return { message: t(locale, "invalidInput"), code: cause.code };
    return { message: t(locale, "operationFailed"), code: cause.code };
  }
  if (cause instanceof TypeError) return { message: t(locale, fallback) };
  return { message: t(locale, cause instanceof Error ? "invalidInput" : fallback) };
}
