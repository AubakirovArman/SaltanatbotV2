import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { listAdminAudit } from "../auth/client";
import { authText } from "../auth/messages";
import { appRoleLabel, authErrorMessage, formatAuthTime, tradingRoleLabel } from "../auth/presentation";
import type { AdminAuditPage, AdminAuditState } from "../auth/types";
import type { Locale } from "../i18n";
import { AdminPagination } from "./AdminPagination";

const PAGE_SIZE = 25;

export function AdminAuditLog({ locale }: { locale: Locale }) {
  const titleId = useId();
  const [result, setResult] = useState<AdminAuditPage>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [eventTypeDraft, setEventTypeDraft] = useState("");
  const [subjectDraft, setSubjectDraft] = useState("");
  const [eventType, setEventType] = useState("");
  const [subjectUserId, setSubjectUserId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await listAdminAudit({
        page,
        pageSize: PAGE_SIZE,
        eventType: eventType || undefined,
        subjectUserId: subjectUserId || undefined
      }));
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setLoading(false);
    }
  }, [eventType, locale, page, subjectUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setEventType(eventTypeDraft.trim());
    setSubjectUserId(subjectDraft.trim());
  };

  const clear = () => {
    setPage(1);
    setEventTypeDraft("");
    setSubjectDraft("");
    setEventType("");
    setSubjectUserId("");
  };

  return (
    <section className="auth-audit-section" aria-labelledby={titleId}>
      <header className="auth-admin-heading">
        <div>
          <h3 id={titleId}>{authText(locale, "auditTitle")}</h3>
          <p>{authText(locale, "auditHelp")}</p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>{authText(locale, "reloadUsers")}</button>
      </header>
      <form className="auth-audit-filters" role="search" aria-label={authText(locale, "auditTitle")} onSubmit={apply}>
        <label>
          <span>{authText(locale, "auditEventFilter")}</span>
          <input maxLength={96} value={eventTypeDraft} placeholder={authText(locale, "auditAllEvents")} onChange={(event) => setEventTypeDraft(event.target.value)} />
        </label>
        <label>
          <span>{authText(locale, "auditSubject")}</span>
          <input maxLength={64} value={subjectDraft} placeholder={authText(locale, "auditSubjectHint")} onChange={(event) => setSubjectDraft(event.target.value)} />
        </label>
        <div className="auth-filter-actions">
          <button type="submit" disabled={loading}>{authText(locale, "applyFilters")}</button>
          <button type="button" disabled={loading} onClick={clear}>{authText(locale, "clearFilters")}</button>
        </div>
      </form>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      {loading && !result ? <p role="status">{authText(locale, "loading")}</p> : null}
      {result && result.events.length === 0 ? <p className="auth-users-empty">{authText(locale, "auditNoEvents")}</p> : null}
      {result?.events.length ? (
        <div className="auth-audit-list">
          {result.events.map((event) => (
            <article className="auth-audit-card" key={event.id}>
              <header>
                <div>
                  <strong>{event.eventType}</strong>
                  <time dateTime={event.occurredAt}>{formatAuthTime(locale, event.occurredAt)}</time>
                </div>
                <span>{event.id}</span>
              </header>
              <dl>
                <div><dt>{authText(locale, "auditActor")}</dt><dd>{event.actorLogin ?? event.actorUserId ?? authText(locale, "systemActor")}</dd></div>
                <div><dt>{authText(locale, "auditSubject")}</dt><dd>{event.subjectLogin ?? event.subjectUserId ?? "—"}</dd></div>
                <div><dt>{authText(locale, "auditReason")}</dt><dd>{event.reason ?? "—"}</dd></div>
                {event.requestId ? <div><dt>{authText(locale, "auditRequestId")}</dt><dd><code>{event.requestId}</code></dd></div> : null}
              </dl>
              {event.before || event.after ? (
                <div className="auth-change-preview">
                  <AuditState label={authText(locale, "before")} locale={locale} state={event.before} />
                  <AuditState label={authText(locale, "after")} locale={locale} state={event.after} />
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {result ? <AdminPagination ariaLabel={authText(locale, "auditTitle")} disabled={loading} locale={locale} onPage={setPage} pagination={result.pagination} /> : null}
    </section>
  );
}

function AuditState({ label, locale, state }: { label: string; locale: Locale; state?: AdminAuditState }) {
  return (
    <section>
      <b>{label}</b>
      {state?.status ? <span>{authText(locale, state.status)}</span> : null}
      {state?.appRole ? <span>{appRoleLabel(locale, state.appRole)}</span> : null}
      {state?.tradingRole ? <span>{tradingRoleLabel(locale, state.tradingRole)}</span> : null}
      {!state ? <span>—</span> : null}
    </section>
  );
}
