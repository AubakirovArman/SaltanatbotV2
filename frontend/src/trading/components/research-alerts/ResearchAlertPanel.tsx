import { BellRing, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../../../i18n";
import "../../../styles/research-alerts.css";
import { deleteResearchAlertPolicy, getResearchAlertState, saveResearchAlertPolicy } from "../../researchAlertClient";
import { researchAlertText as text } from "../../researchAlertText";
import type { ResearchAlertPoliciesResponse, ResearchAlertPolicy, ResearchAlertPolicyInput, ResearchAlertPolicyResponse, ResearchAlertState } from "../../researchAlertTypes";
import { ResearchAlertPolicyEditor } from "./ResearchAlertPolicyEditor";
import { ResearchAlertDeliveryTable, ResearchAlertPolicyTable } from "./ResearchAlertTables";

interface Props {
  locale: Locale;
  pollIntervalMs?: number;
  load?: (signal?: AbortSignal) => Promise<ResearchAlertState>;
  save?: (policy: ResearchAlertPolicyInput) => Promise<ResearchAlertPolicyResponse>;
  remove?: (id: string) => Promise<ResearchAlertPoliciesResponse>;
}

export function ResearchAlertPanel({ locale, pollIntervalMs = 15_000, load = getResearchAlertState, save = saveResearchAlertPolicy, remove = deleteResearchAlertPolicy }: Props) {
  const [state, setState] = useState<ResearchAlertState>();
  const [editing, setEditing] = useState<ResearchAlertPolicy>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const request = useRef<AbortController>();
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const refresh = useCallback(async (background = false) => {
    if (background && request.current && !request.current.signal.aborted) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!background) setRefreshing(true);
    try {
      const next = await load(controller.signal);
      if (!controller.signal.aborted) {
        setState(next);
        if (!background) setError(undefined);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(`${text(locale, "loadFailed")}: ${message(cause)}`);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (!background) setRefreshing(false);
      }
    }
  }, [load, locale]);

  useEffect(() => {
    const onVisibility = () => {
      const nextVisible = document.visibilityState === "visible";
      setVisible(nextVisible);
      if (nextVisible) void refresh(true);
      else request.current?.abort();
    };
    if (document.visibilityState === "visible") void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, Math.max(5_000, pollIntervalMs));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      request.current?.abort();
    };
  }, [pollIntervalMs, refresh]);

  const savePolicy = async (policy: ResearchAlertPolicyInput) => {
    setMutating(true);
    setError(undefined);
    try {
      const response = await save(policy);
      setState((current) => current ? { ...current, policies: [response.policy, ...current.policies.filter((item) => item.id !== response.policy.id)] } : { schemaVersion: 1, researchOnly: true, executionPermission: false, policies: [response.policy], deliveries: [] });
      setEditing(undefined);
      setAnnouncement(text(locale, "saved"));
    } catch (cause) {
      setError(`${text(locale, "saveFailed")}: ${message(cause)}`);
      throw cause;
    } finally {
      setMutating(false);
    }
  };

  const deletePolicy = async (id: string) => {
    setMutating(true);
    setError(undefined);
    try {
      const response = await remove(id);
      setState((current) => current ? { ...current, policies: response.policies } : { schemaVersion: 1, researchOnly: true, executionPermission: false, policies: response.policies, deliveries: [] });
      if (editing?.id === id) setEditing(undefined);
      setPendingDeleteId(undefined);
      setAnnouncement(text(locale, "deleted"));
    } catch (cause) {
      setError(`${text(locale, "deleteFailed")}: ${message(cause)}`);
    } finally {
      setMutating(false);
    }
  };

  return (
    <section className="research-alerts" aria-labelledby="research-alert-title">
      <header className="research-alert-head">
        <div><h2 id="research-alert-title"><BellRing size={20} aria-hidden="true" /> {text(locale, "title")}</h2><p>{text(locale, "description")}</p></div>
        <span className="research-alert-safety"><ShieldCheck size={16} aria-hidden="true" /> {text(locale, "safetyBadge")}</span>
      </header>

      <aside className="research-alert-boundary" aria-label={text(locale, "protectedSession")}><strong>{text(locale, "protectedSession")}</strong><span>{text(locale, "safetyDetail")}</span></aside>

      <div className="research-alert-toolbar"><p>{text(locale, visible ? "pollingActive" : "pollingPaused")}</p><button type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} aria-hidden="true" className={refreshing ? "spin" : undefined} /> {text(locale, refreshing ? "refreshing" : "refresh")}</button></div>

      {error && <div className="research-alert-error" role="alert" tabIndex={-1} ref={errorRef}><TriangleAlert size={16} aria-hidden="true" /><span>{error}</span></div>}
      {state?.lastWorkerError && <div className="research-alert-worker-error" role="status"><TriangleAlert size={16} aria-hidden="true" /><span><strong>{text(locale, "workerError")}</strong>: {state.lastWorkerError}</span></div>}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <ResearchAlertPolicyEditor locale={locale} initial={editing} busy={mutating} onSave={savePolicy} onCancel={() => setEditing(undefined)} />
      <ResearchAlertPolicyTable locale={locale} policies={state?.policies ?? []} editingId={editing?.id} pendingDeleteId={pendingDeleteId} busy={mutating} onEdit={(policy) => { setEditing(policy); setPendingDeleteId(undefined); }} onRequestDelete={setPendingDeleteId} onConfirmDelete={(id) => void deletePolicy(id)} onCancelDelete={() => setPendingDeleteId(undefined)} />
      <ResearchAlertDeliveryTable locale={locale} deliveries={state?.deliveries ?? []} />
    </section>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
