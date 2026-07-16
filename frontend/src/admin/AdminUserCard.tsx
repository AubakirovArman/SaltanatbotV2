import { useEffect, useId, useState } from "react";
import { activateUser, disableUser, updateUserPermissions } from "../auth/client";
import { authText } from "../auth/messages";
import { appRoleLabel, authErrorMessage, formatAuthTime, tradingRoleLabel } from "../auth/presentation";
import type { AdminMutationResult, AppRole, AssignableTradingRole, AuthUser, LifecycleMutation, MutationBase, PermissionUpdate, TradingRole } from "../auth/types";
import type { Locale } from "../i18n";
import { AdminSessionManager } from "./AdminSessionManager";

type AdminAction = "permissions" | "activate" | "reactivate" | "disable";

export function AdminUserCard({
  currentUserId,
  locale,
  onAnnounce,
  onChange,
  onSessionChanged,
  tradingRoleAssignmentsEnabled,
  user
}: {
  currentUserId: string;
  locale: Locale;
  onAnnounce: (message: string) => void;
  onChange: (user: AuthUser) => Promise<void>;
  onSessionChanged: () => Promise<void>;
  tradingRoleAssignmentsEnabled: boolean;
  user: AuthUser;
}) {
  const titleId = useId();
  const ownRoleHelpId = useId();
  const [appRole, setAppRole] = useState<AppRole>(user.appRole);
  const [tradingRole, setTradingRole] = useState<TradingRole>(user.tradingRole);
  const [pendingAction, setPendingAction] = useState<AdminAction>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [sessionsOpen, setSessionsOpen] = useState(false);

  useEffect(() => {
    setAppRole(user.appRole);
    setTradingRole(user.tradingRole);
  }, [user.appRole, user.tradingRole]);

  const isCurrentUser = user.id === currentUserId;
  const changed = appRole !== user.appRole || tradingRole !== user.tradingRole;
  const nextStatus = pendingAction === "disable" ? "disabled" : pendingAction === "activate" || pendingAction === "reactivate" ? "active" : user.status;

  const begin = (action: AdminAction) => {
    setPendingAction(action);
    setReason("");
    setError(undefined);
    setNotice(undefined);
  };

  const submit = async () => {
    const normalizedReason = reason.trim().replace(/\s+/gu, " ");
    if (!pendingAction || normalizedReason.length < 3) {
      setError(authText(locale, "reasonRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const baseMutation: MutationBase = {
        reason: normalizedReason,
        expectedAuthorizationRevision: user.authorizationRevision
      };
      const appRoleChanged = appRole !== user.appRole;
      const tradingRoleChanged = tradingRole !== user.tradingRole && tradingRole !== "live-trade";
      let result: AdminMutationResult;
      if (pendingAction === "disable") {
        result = await disableUser(user.id, baseMutation);
      } else if (pendingAction === "permissions") {
        let permissions: PermissionUpdate;
        if (appRoleChanged) {
          permissions = {
            ...baseMutation,
            appRole,
            ...(tradingRoleChanged ? { tradingRole: tradingRole as AssignableTradingRole } : {})
          };
        } else if (tradingRoleChanged) {
          permissions = {
            ...baseMutation,
            tradingRole: tradingRole as AssignableTradingRole
          };
        } else {
          throw new Error("A permission change is required.");
        }
        result = await updateUserPermissions(user.id, permissions);
      } else {
        const lifecycle: LifecycleMutation = {
          ...baseMutation,
          ...(appRoleChanged ? { appRole } : {}),
          ...(tradingRoleChanged ? { tradingRole: tradingRole as AssignableTradingRole } : {})
        };
        result = await activateUser(user.id, lifecycle, pendingAction === "reactivate");
      }
      setSessionsOpen(false);
      const messageKey = pendingAction === "disable" ? "userDisabled" : pendingAction === "reactivate" ? "userReactivated" : pendingAction === "activate" ? "userActivated" : "permissionsSaved";
      const outcome = [
        authText(locale, messageKey),
        result.revokedSessionCount > 0 ? `${authText(locale, "sessionsClosed")}: ${result.revokedSessionCount}` : "",
        result.cancelledJobCount > 0 ? `${authText(locale, "jobsCancelled")}: ${result.cancelledJobCount}` : ""
      ].filter(Boolean).join(" ");
      setNotice(outcome);
      onAnnounce(`${user.login}: ${outcome}`);
      setPendingAction(undefined);
      setReason("");
      if (result.revokedCurrentSession) await onSessionChanged();
      else await onChange(result.user);
    } catch (cause) {
      setError(authErrorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="auth-user-card" aria-labelledby={titleId}>
      <header>
        <div>
          <strong id={titleId}>{user.login}</strong>
          <small>{authText(locale, "createdAt")}: {formatAuthTime(locale, user.createdAt)} · {authText(locale, "lastLoginAt")}: {formatAuthTime(locale, user.lastLoginAt)}</small>
        </div>
        <span className={`auth-status auth-status-${user.status}`}>{authText(locale, user.status)}</span>
      </header>
      <fieldset className="auth-permission-grid" disabled={busy}>
        <legend className="sr-only">{authText(locale, "permissionsForUser")}: {user.login}</legend>
        <label>
          <span>{authText(locale, "appRole")}</span>
          <select
            value={appRole}
            disabled={busy || isCurrentUser}
            aria-label={`${authText(locale, "appRole")}: ${user.login}`}
            aria-describedby={isCurrentUser ? ownRoleHelpId : undefined}
            onChange={(event) => setAppRole(event.target.value as AppRole)}
          >
            <option value="user">{authText(locale, "userRole")}</option>
            <option value="admin">{authText(locale, "adminRole")}</option>
          </select>
        </label>
        <label>
          <span>{authText(locale, "tradingRole")}</span>
          <select
            value={tradingRole}
            disabled={busy || isCurrentUser}
            aria-label={`${authText(locale, "tradingRole")}: ${user.login}`}
            aria-describedby={user.tradingRole === "live-trade" ? ownRoleHelpId : undefined}
            onChange={(event) => setTradingRole(event.target.value as AssignableTradingRole)}
          >
            <option value="none">{authText(locale, "noTrading")}</option>
            <option value="read-only" disabled={!tradingRoleAssignmentsEnabled}>{authText(locale, "readOnly")}</option>
            <option value="paper-trade" disabled={!tradingRoleAssignmentsEnabled}>{authText(locale, "paperTrade")}</option>
            {user.tradingRole === "live-trade" ? <option value="live-trade" disabled>{authText(locale, "dormantLiveTrade")}</option> : null}
          </select>
        </label>
        {isCurrentUser ? <small id={ownRoleHelpId} className="auth-field-wide">{authText(locale, "ownAdminRoleLocked")}</small> : null}
        {!isCurrentUser && user.tradingRole === "live-trade" ? <small id={ownRoleHelpId} className="auth-field-wide">{authText(locale, "dormantLiveTradeHelp")}</small> : null}
      </fieldset>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      {notice ? <p className="auth-form-success" role="status">{notice}</p> : null}
      {pendingAction ? (
        <div className="auth-confirm-panel" role="group" aria-label={`${authText(locale, "reviewChange")}: ${user.login}`}>
          <strong>{authText(locale, "reviewChange")}</strong>
          <div className="auth-change-preview">
            <StatePreview appRole={user.appRole} label={authText(locale, "before")} locale={locale} status={user.status} tradingRole={user.tradingRole} />
            <StatePreview appRole={appRole} label={authText(locale, "after")} locale={locale} status={nextStatus} tradingRole={tradingRole} />
          </div>
          <p>{authText(locale, "permissionImpact")}</p>
          <label className="auth-reason-field">
            <span>{authText(locale, "reason")}</span>
            <textarea autoFocus maxLength={500} value={reason} placeholder={authText(locale, "reasonHint")} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="auth-confirm-actions">
            <button type="button" disabled={busy} onClick={() => setPendingAction(undefined)}>{authText(locale, "cancel")}</button>
            <button type="button" className={pendingAction === "disable" ? "auth-danger-button" : "auth-activate-button"} disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>
              {busy ? authText(locale, "working") : authText(locale, "confirmAction")}
            </button>
          </div>
        </div>
      ) : null}
      <footer>
        <button type="button" disabled={busy} aria-label={`${authText(locale, sessionsOpen ? "hideSessions" : "viewSessions")}: ${user.login}`} aria-expanded={sessionsOpen} aria-controls={`sessions-${user.id}`} onClick={() => setSessionsOpen((open) => !open)}>
          {authText(locale, sessionsOpen ? "hideSessions" : "viewSessions")}
        </button>
        <button type="button" aria-label={`${authText(locale, "savePermissions")}: ${user.login}`} disabled={busy || !changed || isCurrentUser} onClick={() => begin("permissions")}>{authText(locale, "savePermissions")}</button>
        {user.status === "active" ? (
          <button type="button" className="auth-danger-button" aria-label={`${authText(locale, "disable")}: ${user.login}`} disabled={busy || isCurrentUser} onClick={() => begin("disable")}>{authText(locale, "disable")}</button>
        ) : (
          <button type="button" className="auth-activate-button" aria-label={`${authText(locale, user.status === "disabled" ? "reactivate" : "activate")}: ${user.login}`} disabled={busy} onClick={() => begin(user.status === "disabled" ? "reactivate" : "activate")}>
            {authText(locale, user.status === "disabled" ? "reactivate" : "activate")}
          </button>
        )}
      </footer>
      <div id={`sessions-${user.id}`}>
        {sessionsOpen ? (
          <AdminSessionManager
            active
            locale={locale}
            onAnnounce={onAnnounce}
            onSessionChanged={onSessionChanged}
            user={user}
          />
        ) : null}
      </div>
    </article>
  );
}

function StatePreview({
  appRole,
  label,
  locale,
  status,
  tradingRole
}: {
  appRole: AppRole;
  label: string;
  locale: Locale;
  status: AuthUser["status"];
  tradingRole: TradingRole;
}) {
  return (
    <section>
      <b>{label}</b>
      <span>{authText(locale, status)}</span>
      <span>{appRoleLabel(locale, appRole)}</span>
      <span>{tradingRoleLabel(locale, tradingRole)}</span>
    </section>
  );
}
