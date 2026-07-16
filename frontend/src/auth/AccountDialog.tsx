import { useEffect, useId, useRef, useState } from "react";
import { AdminCenter } from "../admin/AdminCenter";
import type { Locale } from "../i18n";
import { PasswordChangeForm } from "./AuthScreens";
import { authText } from "./messages";
import { appRoleLabel, authErrorMessage, tradingRoleLabel } from "./presentation";
import { SessionManager } from "./SessionManager";
import type { AuthUser } from "./types";

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
  onSessionChanged,
  open,
  tradingRoleAssignmentsEnabled,
  user
}: {
  locale: Locale;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onSessionChanged: () => Promise<void>;
  open: boolean;
  tradingRoleAssignmentsEnabled: boolean;
  user: AuthUser;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const accountTabId = useId();
  const adminTabId = useId();
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
      setLogoutError(authErrorMessage(locale, cause));
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
            <h2 id={titleId}>{section === "admin" ? authText(locale, "adminArea") : authText(locale, "account")}</h2>
          </div>
          <button type="button" className="auth-icon-button" onClick={onClose} aria-label={authText(locale, "close")}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {user.appRole === "admin" ? (
          <div className="auth-dialog-nav" role="tablist" aria-label={authText(locale, "account")}>
            <button type="button" id={accountTabId} role="tab" aria-selected={section === "account"} aria-controls="auth-account-panel" onClick={() => setSection("account")}>
              {authText(locale, "accountArea")}
            </button>
            <button type="button" id={adminTabId} role="tab" aria-selected={section === "admin"} aria-controls="auth-admin-panel" onClick={() => setSection("admin")}>
              {authText(locale, "adminArea")}
            </button>
          </div>
        ) : null}

        <div className="auth-dialog-body">
          <div id="auth-account-panel" role="tabpanel" aria-labelledby={user.appRole === "admin" ? accountTabId : undefined} hidden={section !== "account"}>
            {section === "account" ? <AccountSection active={open} locale={locale} onChangePassword={onChangePassword} onSessionChanged={onSessionChanged} user={user} /> : null}
          </div>
          {user.appRole === "admin" ? (
            <div id="auth-admin-panel" role="tabpanel" aria-labelledby={adminTabId} hidden={section !== "admin"}>
              {section === "admin" ? (
                <AdminCenter
                  currentUserId={user.id}
                  locale={locale}
                  onSessionChanged={onSessionChanged}
                  tradingRoleAssignmentsEnabled={tradingRoleAssignmentsEnabled}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="auth-dialog-footer">
          {logoutError ? <p className="auth-form-error" role="alert">{logoutError}</p> : <span />}
          <button type="button" className="auth-danger-button" disabled={logoutBusy} onClick={() => void logout()}>
            {logoutBusy ? authText(locale, "working") : authText(locale, "signOut")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function AccountSection({
  active,
  locale,
  onChangePassword,
  onSessionChanged,
  user
}: {
  active: boolean;
  locale: Locale;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onSessionChanged: () => Promise<void>;
  user: AuthUser;
}) {
  return (
    <div className="auth-account-layout">
      <section className="auth-account-summary" aria-labelledby="account-summary-title">
        <h3 id="account-summary-title">{authText(locale, "status")}</h3>
        <dl>
          <div><dt>{authText(locale, "status")}</dt><dd><span className={`auth-status auth-status-${user.status}`}>{authText(locale, user.status)}</span></dd></div>
          <div><dt>{authText(locale, "appRole")}</dt><dd>{appRoleLabel(locale, user.appRole)}</dd></div>
          <div><dt>{authText(locale, "tradingRole")}</dt><dd>{user.appRole === "admin" ? authText(locale, "adminRole") : tradingRoleLabel(locale, user.tradingRole)}</dd></div>
        </dl>
      </section>
      <section className="auth-security-section" aria-labelledby="account-security-title">
        <h3 id="account-security-title">{authText(locale, "securityTitle")}</h3>
        <p>{authText(locale, "securityHelp")}</p>
        <PasswordChangeForm locale={locale} onChange={onChangePassword} submitLabel={authText(locale, "changePassword")} />
      </section>
      <SessionManager active={active} locale={locale} onSessionChanged={onSessionChanged} />
    </div>
  );
}
