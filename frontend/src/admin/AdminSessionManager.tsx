import { useCallback, useEffect, useId, useState } from "react";
import { listAdminUserSessions, revokeAdminUserSession, revokeAllAdminUserSessions } from "../auth/client";
import { authText } from "../auth/messages";
import { authErrorMessage, formatAuthTime, sessionDeviceLabel } from "../auth/presentation";
import type { AuthSessionPage, AuthSessionSummary, AuthUser } from "../auth/types";
import type { Locale } from "../i18n";
import { AdminPagination } from "./AdminPagination";

export function AdminSessionManager({
  active,
  locale,
  onAnnounce,
  onSessionChanged,
  user
}: {
  active: boolean;
  locale: Locale;
  onAnnounce: (message: string) => void;
  onSessionChanged: () => Promise<void>;
  user: AuthUser;
}) {
  const titleId = useId();
  const [result, setResult] = useState<AuthSessionPage>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "one"; session: AuthSessionSummary } | { kind: "all" }>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await listAdminUserSessions(user.id, page));
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setLoading(false);
    }
  }, [locale, page, user.id]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const begin = (next: typeof confirm) => {
    setReason("");
    setError(undefined);
    setNotice(undefined);
    setConfirm(next);
  };

  const revoke = async () => {
    const normalizedReason = reason.trim().replace(/\s+/gu, " ");
    if (!confirm || normalizedReason.length < 3) {
      setError(authText(locale, "reasonRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const outcome = confirm.kind === "one"
        ? await revokeAdminUserSession(user.id, confirm.session.publicId, normalizedReason)
        : await revokeAllAdminUserSessions(user.id, normalizedReason);
      const message = authText(locale, confirm.kind === "one" ? "sessionRevoked" : "sessionsRevoked");
      setNotice(message);
      onAnnounce(`${user.login}: ${message}`);
      setConfirm(undefined);
      setReason("");
      if (outcome.revokedCurrentSession) await onSessionChanged();
      else await load();
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  const sessions = result?.sessions ?? [];
  return (
    <section className="auth-admin-sessions" aria-labelledby={titleId}>
      <header className="auth-section-heading">
        <div>
          <h4 id={titleId}>{authText(locale, "sessionsForUser")}: {user.login}</h4>
          <p>{authText(locale, "sessionRevocationWarning")}</p>
        </div>
        <button type="button" disabled={loading || busy} onClick={() => void load()}>{authText(locale, "reloadUsers")}</button>
      </header>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      {notice ? <p className="auth-form-success" role="status">{notice}</p> : null}
      {loading && !result ? <p role="status">{authText(locale, "loading")}</p> : null}
      {result && sessions.length === 0 ? <p className="auth-users-empty">{authText(locale, "noSessions")}</p> : null}
      {sessions.length > 0 ? (
        <div className="auth-session-list compact">
          {sessions.map((session) => (
            <article className="auth-session-card" key={session.publicId}>
              <header>
                <strong>{sessionDeviceLabel(locale, session)}</strong>
                {session.current ? <span className="auth-current-session">{authText(locale, "currentSession")}</span> : session.revokedAt ? <span className="auth-current-session">{authText(locale, "sessionRevoked")}</span> : null}
              </header>
              <dl>
                <div><dt>{authText(locale, "sessionLastSeen")}</dt><dd><time dateTime={session.lastSeenAt}>{formatAuthTime(locale, session.lastSeenAt)}</time></dd></div>
                <div><dt>{authText(locale, "sessionExpires")}</dt><dd><time dateTime={session.expiresAt}>{formatAuthTime(locale, session.expiresAt)}</time></dd></div>
                {session.ipAddress ? <div><dt>{authText(locale, "sessionIp")}</dt><dd>{session.ipAddress}</dd></div> : null}
              </dl>
              {!session.revokedAt ? <button type="button" className="auth-danger-button" aria-label={`${authText(locale, "revokeSession")}: ${sessionDeviceLabel(locale, session)}`} disabled={busy} onClick={() => begin({ kind: "one", session })}>{authText(locale, "revokeSession")}</button> : null}
            </article>
          ))}
        </div>
      ) : null}
      {confirm ? (
        <div className="auth-confirm-panel" role="group" aria-label={authText(locale, "reviewChange")}>
          <strong>{authText(locale, confirm.kind === "one" ? "revokeSession" : "revokeAllSessions")}</strong>
          <label className="auth-reason-field">
            <span>{authText(locale, "reason")}</span>
            <textarea autoFocus maxLength={500} value={reason} placeholder={authText(locale, "adminSessionReason")} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="auth-confirm-actions">
            <button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{authText(locale, "cancel")}</button>
            <button type="button" className="auth-danger-button" disabled={busy || reason.trim().length < 3} onClick={() => void revoke()}>
              {busy ? authText(locale, "working") : authText(locale, "confirmAction")}
            </button>
          </div>
        </div>
      ) : null}
      {(result?.revocableSessionCount ?? 0) > 0 && !confirm ? (
        <button type="button" className="auth-danger-button auth-revoke-others" aria-label={`${authText(locale, "revokeAllSessions")}: ${user.login}`} disabled={busy} onClick={() => begin({ kind: "all" })}>
          {authText(locale, "revokeAllSessions")}
        </button>
      ) : null}
      {result ? <AdminPagination ariaLabel={`${authText(locale, "sessionsForUser")}: ${user.login}`} disabled={loading || busy} locale={locale} onPage={setPage} pagination={result.pagination} /> : null}
    </section>
  );
}
