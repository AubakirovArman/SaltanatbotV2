import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Locale } from "../i18n";
import { activateUser, AuthApiError, disableUser, listUsers, updateUserPermissions } from "./client";
import { PasswordChangeForm } from "./AuthScreens";
import { authErrorText, authText } from "./messages";
import type { AppRole, AuthUser, PermissionUpdate, TradingRole } from "./types";

export function AccountLauncher({
  locale,
  onOpen,
  user
}: {
  locale: Locale;
  onOpen: () => void;
  user: AuthUser;
}) {
  return (
    <button type="button" className="auth-account-launcher" aria-label={`${authText(locale, "account")}: ${user.login}`} title={`${authText(locale, "account")}: ${user.login}`} onClick={onOpen}>
      <b aria-hidden="true">{user.login.slice(0, 1).toLocaleUpperCase()}</b>
      <span>{user.login}</span>
    </button>
  );
}

export function AccountDialog({
  locale,
  onChangePassword,
  onClose,
  onLogout,
  open,
  tradingRoleAssignmentsEnabled,
  user
}: {
  locale: Locale;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
  onLogout: () => Promise<void>;
  open: boolean;
  tradingRoleAssignmentsEnabled: boolean;
  user: AuthUser;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [section, setSection] = useState<"account" | "admin">("account");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSection("account");
    setLogoutError(undefined);
  }, [open]);

  const logout = async () => {
    setLogoutBusy(true);
    setLogoutError(undefined);
    try {
      await onLogout();
    } catch (cause) {
      setLogoutError(errorMessage(locale, cause));
    } finally {
      setLogoutBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="auth-account-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="auth-dialog-shell">
        <header className="auth-dialog-header">
          <div>
            <p className="auth-eyebrow">{user.login}</p>
            <h2 id={titleId}>{authText(locale, "account")}</h2>
          </div>
          <button type="button" className="auth-icon-button" onClick={onClose} aria-label={authText(locale, "close")}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {user.appRole === "admin" ? (
          <nav className="auth-dialog-nav" aria-label={authText(locale, "account")}>
            <button type="button" aria-pressed={section === "account"} onClick={() => setSection("account")}>
              {authText(locale, "accountArea")}
            </button>
            <button type="button" aria-pressed={section === "admin"} onClick={() => setSection("admin")}>
              {authText(locale, "adminArea")}
            </button>
          </nav>
        ) : null}

        <div className="auth-dialog-body">{section === "admin" && user.appRole === "admin" ? <AdminUsers locale={locale} currentUserId={user.id} tradingRoleAssignmentsEnabled={tradingRoleAssignmentsEnabled} /> : <AccountSection locale={locale} onChangePassword={onChangePassword} user={user} />}</div>

        <footer className="auth-dialog-footer">
          {logoutError ? (
            <p className="auth-form-error" role="alert">
              {logoutError}
            </p>
          ) : (
            <span />
          )}
          <button type="button" className="auth-danger-button" disabled={logoutBusy} onClick={() => void logout()}>
            {logoutBusy ? authText(locale, "working") : authText(locale, "signOut")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function AccountSection({
  locale,
  onChangePassword,
  user
}: {
  locale: Locale;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  user: AuthUser;
}) {
  return (
    <div className="auth-account-section">
      <section className="auth-account-summary" aria-labelledby="account-summary-title">
        <h3 id="account-summary-title">{authText(locale, "status")}</h3>
        <dl>
          <div>
            <dt>{authText(locale, "status")}</dt>
            <dd>
              <StatusBadge locale={locale} status={user.status} />
            </dd>
          </div>
          <div>
            <dt>{authText(locale, "appRole")}</dt>
            <dd>{appRoleLabel(locale, user.appRole)}</dd>
          </div>
          <div>
            <dt>{authText(locale, "tradingRole")}</dt>
            <dd>{user.appRole === "admin" ? authText(locale, "adminRole") : tradingRoleLabel(locale, user.tradingRole)}</dd>
          </div>
        </dl>
      </section>
      <section className="auth-security-section" aria-labelledby="account-security-title">
        <h3 id="account-security-title">{authText(locale, "securityTitle")}</h3>
        <p>{authText(locale, "securityHelp")}</p>
        <PasswordChangeForm locale={locale} onChange={onChangePassword} submitLabel={authText(locale, "changePassword")} />
      </section>
    </div>
  );
}

function AdminUsers({
  currentUserId,
  locale,
  tradingRoleAssignmentsEnabled
}: {
  currentUserId: string;
  locale: Locale;
  tradingRoleAssignmentsEnabled: boolean;
}) {
  const [users, setUsers] = useState<AuthUser[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AuthUser["status"]>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setUsers(await listUsers());
    } catch (cause) {
      setError(errorMessage(locale, cause));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceUser = (next: AuthUser) => {
    setUsers((current) => current?.map((item) => (item.id === next.id ? next : item)));
  };

  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return users?.filter((item) => (statusFilter === "all" || item.status === statusFilter) && (normalizedQuery.length === 0 || item.login.toLocaleLowerCase(locale).includes(normalizedQuery)));
  }, [locale, query, statusFilter, users]);

  return (
    <section className="auth-admin-section" aria-labelledby="admin-users-title">
      <header className="auth-admin-heading">
        <div>
          <h3 id="admin-users-title">{authText(locale, "usersTitle")}</h3>
          <p>{authText(locale, "usersHelp")}</p>
          {!tradingRoleAssignmentsEnabled ? <p className="auth-migration-note">{authText(locale, "tradingMigrationPending")}</p> : null}
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>
          {authText(locale, "reloadUsers")}
        </button>
      </header>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {error ? (
        <p className="auth-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !users ? (
        <p className="auth-users-loading" role="status">
          {authText(locale, "loading")}
        </p>
      ) : null}
      {users?.length === 0 ? <p className="auth-users-empty">{authText(locale, "noUsers")}</p> : null}
      {users && users.length > 0 ? (
        <div className="auth-user-filters" role="search" aria-label={authText(locale, "userFilters")}>
          <label>
            <span>{authText(locale, "searchUsers")}</span>
            <input type="search" value={query} autoComplete="off" placeholder={authText(locale, "searchUsersHint")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            <span>{authText(locale, "filterStatus")}</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">{authText(locale, "allStatuses")}</option>
              <option value="pending">{authText(locale, "pending")}</option>
              <option value="active">{authText(locale, "active")}</option>
              <option value="disabled">{authText(locale, "disabled")}</option>
            </select>
          </label>
          <output aria-live="polite">
            {authText(locale, "usersShown")}: {filteredUsers?.length ?? 0} / {users.length}
          </output>
        </div>
      ) : null}
      {users && users.length > 0 && filteredUsers?.length === 0 ? <p className="auth-users-empty">{authText(locale, "noMatchingUsers")}</p> : null}
      {filteredUsers && filteredUsers.length > 0 ? (
        <div className="auth-user-list">
          {filteredUsers.map((item) => (
            <AdminUserCard key={item.id} currentUserId={currentUserId} locale={locale} onAnnounce={setAnnouncement} onChange={replaceUser} tradingRoleAssignmentsEnabled={tradingRoleAssignmentsEnabled} user={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AdminUserCard({
  currentUserId,
  locale,
  onAnnounce,
  onChange,
  tradingRoleAssignmentsEnabled,
  user
}: {
  currentUserId: string;
  locale: Locale;
  onAnnounce: (message: string) => void;
  onChange: (user: AuthUser) => void;
  tradingRoleAssignmentsEnabled: boolean;
  user: AuthUser;
}) {
  const [appRole, setAppRole] = useState<AppRole>(user.appRole);
  const [tradingRole, setTradingRole] = useState<TradingRole>(user.tradingRole);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const cardTitleId = useId();
  const ownRoleHelpId = useId();

  useEffect(() => {
    setAppRole(user.appRole);
    setTradingRole(user.tradingRole);
  }, [user.appRole, user.tradingRole]);

  const mutate = async (operation: () => Promise<AuthUser>, messageKey: "permissionsSaved" | "userActivated" | "userDisabled") => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await operation();
      onChange(next);
      const message = `${user.login}: ${authText(locale, messageKey)}`;
      setNotice(authText(locale, messageKey));
      onAnnounce(message);
    } catch (cause) {
      setError(errorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  const changed = appRole !== user.appRole || tradingRole !== user.tradingRole;
  const permissionUpdate: PermissionUpdate = { appRole, tradingRole };
  const isCurrentUser = user.id === currentUserId;

  const activate = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    let permissionsSaved = false;
    try {
      if (changed) {
        const updated = await updateUserPermissions(user.id, permissionUpdate);
        permissionsSaved = true;
        onChange(updated);
      }
      const activated = await activateUser(user.id);
      onChange(activated);
      const messageKey = changed ? "userActivatedWithPermissions" : "userActivated";
      const message = authText(locale, messageKey);
      setNotice(message);
      onAnnounce(`${user.login}: ${message}`);
    } catch (cause) {
      setError(permissionsSaved ? authText(locale, "activationFailedAfterPermissions") : errorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="auth-user-card" aria-labelledby={cardTitleId}>
      <header>
        <strong id={cardTitleId}>{user.login}</strong>
        <StatusBadge locale={locale} status={user.status} />
      </header>
      <fieldset className="auth-permission-grid">
        <legend className="sr-only">
          {authText(locale, "permissionsForUser")}: {user.login}
        </legend>
        <label>
          <span>{authText(locale, "appRole")}</span>
          <select value={appRole} disabled={busy || isCurrentUser} aria-label={`${authText(locale, "appRole")}: ${user.login}`} aria-describedby={isCurrentUser ? ownRoleHelpId : undefined} onChange={(event) => setAppRole(event.target.value as AppRole)}>
            <option value="user">{authText(locale, "userRole")}</option>
            <option value="admin">{authText(locale, "adminRole")}</option>
          </select>
          {isCurrentUser ? <small id={ownRoleHelpId}>{authText(locale, "ownAdminRoleLocked")}</small> : null}
        </label>
        <label>
          <span>{authText(locale, "tradingRole")}</span>
          <select value={tradingRole} disabled={busy} aria-label={`${authText(locale, "tradingRole")}: ${user.login}`} onChange={(event) => setTradingRole(event.target.value as TradingRole)}>
            <option value="none">{authText(locale, "noTrading")}</option>
            <option value="read-only" disabled={!tradingRoleAssignmentsEnabled}>
              {authText(locale, "readOnly")}
            </option>
            <option value="paper-trade" disabled={!tradingRoleAssignmentsEnabled}>
              {authText(locale, "paperTrade")}
            </option>
            <option value="live-trade" disabled={!tradingRoleAssignmentsEnabled}>
              {authText(locale, "liveTrade")}
            </option>
          </select>
        </label>
      </fieldset>
      {error ? (
        <p className="auth-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="auth-form-success" role="status">
          {notice}
        </p>
      ) : null}
      <footer>
        <button type="button" disabled={busy || !changed} aria-label={`${authText(locale, "savePermissions")}: ${user.login}`} onClick={() => void mutate(() => updateUserPermissions(user.id, permissionUpdate), "permissionsSaved")}>
          {authText(locale, "savePermissions")}
        </button>
        {user.status === "active" ? (
          <button type="button" className="auth-danger-button" disabled={busy || isCurrentUser} aria-label={`${authText(locale, "disable")}: ${user.login}`} onClick={() => void mutate(() => disableUser(user.id), "userDisabled")}>
            {authText(locale, "disable")}
          </button>
        ) : (
          <button type="button" className="auth-activate-button" disabled={busy} aria-label={`${changed ? authText(locale, "saveAndActivate") : authText(locale, "activate")}: ${user.login}`} onClick={() => void activate()}>
            {changed ? authText(locale, "saveAndActivate") : authText(locale, "activate")}
          </button>
        )}
      </footer>
    </article>
  );
}

function StatusBadge({ locale, status }: { locale: Locale; status: AuthUser["status"] }) {
  return <span className={`auth-status auth-status-${status}`}>{authText(locale, status)}</span>;
}

function appRoleLabel(locale: Locale, role: AppRole): string {
  return authText(locale, role === "admin" ? "adminRole" : "userRole");
}

function tradingRoleLabel(locale: Locale, role: TradingRole): string {
  const keys: Record<TradingRole, Parameters<typeof authText>[1]> = {
    none: "noTrading",
    "read-only": "readOnly",
    "paper-trade": "paperTrade",
    "live-trade": "liveTrade"
  };
  return authText(locale, keys[role]);
}

function errorMessage(locale: Locale, cause: unknown): string {
  return cause instanceof AuthApiError ? authErrorText(locale, cause.code) : authText(locale, "errorGeneric");
}
