import { useCallback, useEffect, useId, useState } from "react";
import type { Locale } from "../i18n";
import { listOwnSessions, revokeOtherSessions, revokeOwnSession } from "./client";
import { authText } from "./messages";
import { authErrorMessage, formatAuthTime, sessionDeviceLabel } from "./presentation";
import type { AuthSessionPage, AuthSessionSummary } from "./types";

export function SessionManager({
  active,
  locale,
  onSessionChanged
}: {
  active: boolean;
  locale: Locale;
  onSessionChanged: () => Promise<void>;
}) {
  const titleId = useId();
  const [result, setResult] = useState<AuthSessionPage>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "one"; session: AuthSessionSummary } | { kind: "others" }>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await listOwnSessions(page));
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setLoading(false);
    }
  }, [locale, page]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const revoke = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = confirm.kind === "one"
        ? await revokeOwnSession(confirm.session.publicId)
        : await revokeOtherSessions();
      setNotice(authText(locale, confirm.kind === "one" ? "sessionRevoked" : "sessionsRevoked"));
      setConfirm(undefined);
      if (outcome.revokedCurrentSession) await onSessionChanged();
      else await load();
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  const sessions = result?.sessions ?? [];
  const hasOtherSessions = (result?.revocableSessionCount ?? 0) > 1;

  return (
    <section className="auth-session-section" aria-labelledby={titleId}>
      <header className="auth-section-heading">
        <div>
          <h3 id={titleId}>{authText(locale, "sessionsTitle")}</h3>
          <p>{authText(locale, "sessionsHelp")}</p>
        </div>
        <button type="button" disabled={loading || busy} onClick={() => void load()}>
          {authText(locale, "reloadUsers")}
        </button>
      </header>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      {notice ? <p className="auth-form-success" role="status">{notice}</p> : null}
      {loading && !result ? <p role="status">{authText(locale, "loading")}</p> : null}
      {result && sessions.length === 0 ? <p className="auth-users-empty">{authText(locale, "noSessions")}</p> : null}
      {sessions.length > 0 ? (
        <div className="auth-session-list">
          {sessions.map((session) => (
            <SessionCard
              key={session.publicId}
              locale={locale}
              session={session}
              disabled={busy}
              onRevoke={() => setConfirm({ kind: "one", session })}
            />
          ))}
        </div>
      ) : null}
      {confirm ? (
        <div className="auth-confirm-panel" role="group" aria-label={authText(locale, "reviewChange")}>
          <strong>{authText(locale, confirm.kind === "one" ? "revokeSession" : "revokeOtherSessions")}</strong>
          <p>{authText(locale, "sessionRevocationWarning")}</p>
          <div className="auth-confirm-actions">
            <button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{authText(locale, "cancel")}</button>
            <button type="button" className="auth-danger-button" disabled={busy} onClick={() => void revoke()}>
              {busy ? authText(locale, "working") : authText(locale, "confirmAction")}
            </button>
          </div>
        </div>
      ) : null}
      {hasOtherSessions && !confirm ? (
        <button type="button" className="auth-danger-button auth-revoke-others" disabled={busy} onClick={() => setConfirm({ kind: "others" })}>
          {authText(locale, "revokeOtherSessions")}
        </button>
      ) : result && !loading ? (
        <p className="auth-section-note">{authText(locale, "noOtherSessions")}</p>
      ) : null}
      {result && result.pagination.totalPages > 1 ? (
        <SessionPagination
          locale={locale}
          page={result.pagination.page}
          totalPages={result.pagination.totalPages}
          disabled={loading || busy}
          onPage={setPage}
        />
      ) : null}
    </section>
  );
}

function SessionCard({
  disabled,
  locale,
  onRevoke,
  session
}: {
  disabled: boolean;
  locale: Locale;
  onRevoke: () => void;
  session: AuthSessionSummary;
}) {
  return (
    <article className={`auth-session-card ${session.current ? "current" : ""}`}>
      <header>
        <strong>{sessionDeviceLabel(locale, session)}</strong>
        {session.current ? <span className="auth-current-session">{authText(locale, "currentSession")}</span> : session.revokedAt ? <span className="auth-current-session">{authText(locale, "sessionRevoked")}</span> : null}
      </header>
      <dl>
        <div><dt>{authText(locale, "sessionLastSeen")}</dt><dd><time dateTime={session.lastSeenAt}>{formatAuthTime(locale, session.lastSeenAt)}</time></dd></div>
        <div><dt>{authText(locale, "sessionCreated")}</dt><dd><time dateTime={session.createdAt}>{formatAuthTime(locale, session.createdAt)}</time></dd></div>
        <div><dt>{authText(locale, "sessionExpires")}</dt><dd><time dateTime={session.expiresAt}>{formatAuthTime(locale, session.expiresAt)}</time></dd></div>
        {session.ipAddress ? <div><dt>{authText(locale, "sessionIp")}</dt><dd>{session.ipAddress}</dd></div> : null}
      </dl>
      {!session.revokedAt ? (
        <button type="button" className="auth-danger-button" aria-label={`${authText(locale, "revokeSession")}: ${sessionDeviceLabel(locale, session)}`} disabled={disabled} onClick={onRevoke}>
          {authText(locale, "revokeSession")}
        </button>
      ) : null}
    </article>
  );
}

function SessionPagination({
  disabled,
  locale,
  onPage,
  page,
  totalPages
}: {
  disabled: boolean;
  locale: Locale;
  onPage: (page: number) => void;
  page: number;
  totalPages: number;
}) {
  return (
    <nav className="auth-pagination" aria-label={authText(locale, "sessionsTitle")}>
      <button type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>{authText(locale, "previousPage")}</button>
      <span>{authText(locale, "pageOf").replace("{page}", String(page)).replace("{total}", String(totalPages))}</span>
      <button type="button" disabled={disabled || page >= totalPages} onClick={() => onPage(page + 1)}>{authText(locale, "nextPage")}</button>
    </nav>
  );
}
