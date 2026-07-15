import { BookOpenCheck, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { localeTag, type Locale } from "../../../i18n";
import "../../../styles/paper-multi-leg.css";
import { getPaperMultiLegRecovery, getPaperMultiLegRun, listPaperMultiLegRuns, submitPaperMultiLegRun } from "../../paperMultiLegClient";
import { parsePaperMultiLegPlanJson } from "../../paperMultiLegParser";
import { paperMultiLegStatusText, paperMultiLegText as text } from "../../paperMultiLegText";
import type { PaperMultiLegEvent, PaperMultiLegPlan, PaperMultiLegRecoveryStatus, PaperMultiLegRunSummary, PaperMultiLegRunView } from "../../paperMultiLegTypes";

interface Props {
  locale: Locale;
}

export function PaperMultiLegPanel({ locale }: Props) {
  const [runs, setRuns] = useState<PaperMultiLegRunSummary[]>([]);
  const [recovery, setRecovery] = useState<PaperMultiLegRecoveryStatus>();
  const [selected, setSelected] = useState<PaperMultiLegRunView>();
  const [planJson, setPlanJson] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const planHintId = useId();
  const idempotencyHintId = useId();
  const errorRef = useRef<HTMLDivElement>(null);
  const refreshController = useRef<AbortController>();
  const runController = useRef<AbortController>();

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const refresh = useCallback(
    async (background = false) => {
      if (background && refreshController.current) return;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      if (!background) setRefreshing(true);
      try {
        const [list, status] = await Promise.all([listPaperMultiLegRuns(50, controller.signal), getPaperMultiLegRecovery(controller.signal)]);
        setRuns(list.runs);
        setRecovery(status.recovery);
        if (!background) setError(undefined);
      } catch (cause) {
        if (!controller.signal.aborted) setError(`${text(locale, "loadFailed")}: ${message(cause)}`);
      } finally {
        if (refreshController.current === controller) {
          refreshController.current = undefined;
          if (!background && !controller.signal.aborted) setRefreshing(false);
        }
      }
    },
    [locale]
  );

  useEffect(() => {
    void refresh();
    const poll = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = window.setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      refreshController.current?.abort();
      runController.current?.abort();
    };
  }, [refresh]);

  const openRun = useCallback(
    async (runId: string) => {
      runController.current?.abort();
      const controller = new AbortController();
      runController.current = controller;
      setLoadingRunId(runId);
      setError(undefined);
      try {
        const response = await getPaperMultiLegRun(runId, controller.signal);
        setSelected(response.run);
        setAnnouncement(`${text(locale, "journal")}: ${runId}`);
      } catch (cause) {
        if (!controller.signal.aborted) setError(`${text(locale, "loadFailed")}: ${message(cause)}`);
      } finally {
        if (!controller.signal.aborted) setLoadingRunId(undefined);
      }
    },
    [locale]
  );

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setAnnouncement("");
    let plan: PaperMultiLegPlan;
    try {
      plan = parsePaperMultiLegPlanJson(planJson);
    } catch (cause) {
      setError(`${text(locale, "invalidPlan")}: ${message(cause)}`);
      setSubmitting(false);
      return;
    }
    try {
      const result = await submitPaperMultiLegRun(plan, idempotencyKey.trim());
      setSelected(result.run);
      setAnnouncement(text(locale, result.created ? "created" : "reused"));
      await refresh(true);
    } catch (cause) {
      setError(`${text(locale, "submitFailed")}: ${message(cause)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="paper-multi-leg" aria-labelledby="paper-multi-leg-title">
      <header className="paper-multi-leg-head">
        <div>
          <h2 id="paper-multi-leg-title">
            <BookOpenCheck size={20} aria-hidden="true" /> {text(locale, "title")}
          </h2>
          <p>{text(locale, "description")}</p>
        </div>
        <span className="paper-multi-leg-safety">
          <ShieldCheck size={15} aria-hidden="true" /> {text(locale, "paperOnly")}
        </span>
      </header>

      <RecoveryBanner locale={locale} recovery={recovery} />

      <div className="paper-multi-leg-toolbar">
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={15} aria-hidden="true" className={refreshing ? "spin" : undefined} />
          {text(locale, refreshing ? "refreshing" : "refresh")}
        </button>
      </div>

      {error && (
        <div className="paper-multi-leg-error" role="alert" tabIndex={-1} ref={errorRef}>
          <TriangleAlert size={16} aria-hidden="true" /> <span>{error}</span>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <form className="paper-multi-leg-form" action="/api/trade/paper-multi-leg/runs" method="post" onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend>{text(locale, "formLegend")}</legend>
          <label htmlFor="paper-multi-leg-plan">{text(locale, "planLabel")}</label>
          <p id={planHintId}>{text(locale, "planHint")}</p>
          <textarea id="paper-multi-leg-plan" name="paper-plan" value={planJson} required maxLength={65_536} rows={10} spellCheck={false} autoComplete="off" aria-describedby={planHintId} onChange={(event) => setPlanJson(event.target.value)} />
          <label htmlFor="paper-multi-leg-idempotency">{text(locale, "idempotencyLabel")}</label>
          <p id={idempotencyHintId}>{text(locale, "idempotencyHint")}</p>
          <input id="paper-multi-leg-idempotency" name="idempotency-key" value={idempotencyKey} required minLength={8} maxLength={160} pattern="[A-Za-z0-9][A-Za-z0-9:._-]*" spellCheck={false} autoComplete="off" aria-describedby={idempotencyHintId} onChange={(event) => setIdempotencyKey(event.target.value)} />
          <button type="submit" className="run-button" disabled={submitting}>
            {text(locale, submitting ? "submitting" : "submit")}
          </button>
        </fieldset>
      </form>

      <RunList locale={locale} runs={runs} selectedRunId={selected?.state.runId} loadingRunId={loadingRunId} onOpen={openRun} />
      <RunJournal locale={locale} run={selected} />
    </section>
  );
}

function RecoveryBanner({ locale, recovery }: { locale: Locale; recovery?: PaperMultiLegRecoveryStatus }) {
  const status = recovery?.status ?? "running";
  const label = status === "ready" ? "recoveryReady" : status === "failed" ? "recoveryFailed" : status === "not-run" ? "recoveryNotRun" : "recoveryRunning";
  return (
    <aside className={`paper-multi-leg-recovery ${status}`} aria-label={text(locale, "recovery")} aria-live="polite">
      <strong>
        {text(locale, "recovery")}: {text(locale, label)}
      </strong>
      {recovery && (
        <span>
          {text(locale, "recoveredRuns")}: {recovery.recoveredRuns}
        </span>
      )}
      {recovery?.completedAt && (
        <time dateTime={new Date(recovery.completedAt).toISOString()}>
          {text(locale, "completedAt")}: {date(recovery.completedAt, locale)}
        </time>
      )}
    </aside>
  );
}

function RunList({ locale, runs, selectedRunId, loadingRunId, onOpen }: { locale: Locale; runs: PaperMultiLegRunSummary[]; selectedRunId?: string; loadingRunId?: string; onOpen: (runId: string) => void }) {
  return (
    <section className="paper-multi-leg-section" aria-labelledby="paper-multi-leg-history">
      <h3 id="paper-multi-leg-history">{text(locale, "history")}</h3>
      {runs.length === 0 ? (
        <p>{text(locale, "noRuns")}</p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded table is horizontally scrollable by keyboard on narrow screens.
        <div className="paper-multi-leg-table" role="region" aria-label={text(locale, "historyCaption")} tabIndex={0}>
          <table>
            <caption>{text(locale, "historyCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{text(locale, "runId")}</th>
                <th scope="col">{text(locale, "status")}</th>
                <th scope="col">{text(locale, "source")}</th>
                <th scope="col">{text(locale, "legs")}</th>
                <th scope="col">{text(locale, "updated")}</th>
                <th scope="col">{text(locale, "action")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} className={selectedRunId === run.runId ? "selected" : undefined}>
                  <th scope="row">
                    <code>{run.runId}</code>
                  </th>
                  <td>
                    <Status locale={locale} status={run.status} />
                  </td>
                  <td>
                    {run.sourceKind}
                    <small>{run.opportunityId}</small>
                  </td>
                  <td>{run.legCount}</td>
                  <td>
                    <time dateTime={new Date(run.updatedAt).toISOString()}>{date(run.updatedAt, locale)}</time>
                  </td>
                  <td>
                    <button type="button" onClick={() => onOpen(run.runId)} disabled={loadingRunId === run.runId} aria-label={`${text(locale, "view")}: ${run.runId}`}>
                      {loadingRunId === run.runId ? text(locale, "loadingRun") : text(locale, "view")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunJournal({ locale, run }: { locale: Locale; run?: PaperMultiLegRunView }) {
  return (
    <section className="paper-multi-leg-section" aria-labelledby="paper-multi-leg-journal">
      <h3 id="paper-multi-leg-journal">
        {text(locale, "journal")}
        {run ? ` · ${run.state.runId}` : ""}
      </h3>
      {!run ? (
        <p>{text(locale, "noSelection")}</p>
      ) : (
        <>
          <div className="paper-multi-leg-state">
            <Status locale={locale} status={run.state.status} />
            <span>
              {text(locale, "legs")}: {run.state.plan.legs.length}
            </span>
            <span>
              {text(locale, "source")}: {run.state.plan.source.kind}
            </span>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded table is horizontally scrollable by keyboard on narrow screens. */}
          <div className="paper-multi-leg-table" role="region" aria-label={text(locale, "journalCaption")} tabIndex={0}>
            <table>
              <caption>{text(locale, "journalCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{text(locale, "sequence")}</th>
                  <th scope="col">{text(locale, "time")}</th>
                  <th scope="col">{text(locale, "event")}</th>
                  <th scope="col">{text(locale, "details")}</th>
                </tr>
              </thead>
              <tbody>
                {run.events.map((event) => (
                  <tr key={event.eventId}>
                    <th scope="row">{event.sequence}</th>
                    <td>
                      <time dateTime={new Date(event.ts).toISOString()}>{date(event.ts, locale)}</time>
                    </td>
                    <td>{eventName(event, locale)}</td>
                    <td>{eventDetails(event, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Status({ locale, status }: { locale: Locale; status: PaperMultiLegRunSummary["status"] }) {
  return <span className={`paper-multi-leg-status ${status}`}>{paperMultiLegStatusText(locale, status)}</span>;
}

function eventName(event: PaperMultiLegEvent, locale: Locale): string {
  if (event.type === "run-created") return text(locale, "runCreated");
  if (event.type === "original-fill") return text(locale, "originalFill");
  if (event.type === "compensation-fill") return text(locale, "compensationFill");
  if (event.type === "compensation-decision") return text(locale, "decision");
  return text(locale, "terminal");
}

function eventDetails(event: PaperMultiLegEvent, locale: Locale): string {
  if (event.type === "run-created") return `${event.data.plan.source.kind} · ${text(locale, "legs")}: ${event.data.plan.legs.length}`;
  if (event.type === "original-fill" || event.type === "compensation-fill") {
    const fill = event.data.fill;
    return `${fill.legId} · ${fill.side} · ${text(locale, "quantity")}: ${number(fill.filledQuantity, locale)}/${number(fill.requestedQuantity, locale)} ${fill.quantityUnit}`;
  }
  if (event.type === "compensation-decision") return `${event.data.decision.action} · ${text(locale, "targets")}: ${event.data.decision.targetLegIds.join(", ") || "—"}`;
  if (event.type === "run-terminal") return `${paperMultiLegStatusText(locale, event.data.terminal.status)} · ${text(locale, "unresolved")}: ${event.data.terminal.unresolvedExposure.length}`;
  return "—";
}

function createIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${performance.now().toFixed(3).replace(".", "-")}`;
  return `paper-ui-${id}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown error";
}

function date(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);
}

function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}
