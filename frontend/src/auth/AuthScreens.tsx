import { useState, type FormEvent } from "react";
import { localeNames, storeLocale, supportedLocales, type Locale } from "../i18n";
import { AuthApiError } from "./client";
import { authErrorText, authText } from "./messages";
import { PasswordField } from "./PasswordField";

export function AuthLoadingScreen({ locale }: { locale: Locale }) {
  return (
    <AuthPage locale={locale} onLocaleChange={() => undefined} languageLocked>
      <div className="auth-state-card" role="status">
        <span className="auth-spinner" aria-hidden="true" />
        <p>{authText(locale, "loading")}</p>
      </div>
    </AuthPage>
  );
}

export function AuthUnavailableScreen({ locale, onLocaleChange, onRetry }: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onRetry: () => void;
}) {
  return (
    <AuthPage locale={locale} onLocaleChange={onLocaleChange}>
      <div className="auth-state-card">
        <h1>{authText(locale, "serviceUnavailableTitle")}</h1>
        <p>{authText(locale, "serviceUnavailableHelp")}</p>
        <button type="button" className="auth-primary-button" onClick={onRetry}>
          {authText(locale, "retry")}
        </button>
      </div>
    </AuthPage>
  );
}

export function SignInScreen({ locale, notice, onLocaleChange, onLogin, onRegister, registrationEnabled }: {
  locale: Locale;
  notice?: string;
  onLocaleChange: (locale: Locale) => void;
  onLogin: (login: string, password: string) => Promise<void>;
  onRegister: (login: string, password: string) => Promise<void>;
  registrationEnabled: boolean;
}) {
  const [view, setView] = useState<"login" | "register">("login");
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = (key: Parameters<typeof authText>[1]) => authText(locale, key);
  const registering = view === "register";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (registering) await onRegister(loginValue, password);
      else await onLogin(loginValue, password);
    } catch (cause) {
      setError(errorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthPage locale={locale} onLocaleChange={onLocaleChange}>
      <section className="auth-card" aria-labelledby="auth-form-title">
        <header className="auth-card-header">
          <div>
            <p className="auth-eyebrow">{t("eyebrow")}</p>
            <h1 id="auth-form-title">{t(registering ? "registerTitle" : "signInTitle")}</h1>
          </div>
        </header>
        <p className="auth-card-help">{t(registering ? "registerHelp" : "signInHelp")}</p>
        {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
        {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <div className="auth-field">
            <label htmlFor={registering ? "registration-login" : "login"}>{t("login")}</label>
            {registering ? <span id="registration-login-hint" className="auth-field-hint">{t("loginHint")}</span> : null}
            <input
              id={registering ? "registration-login" : "login"}
              name="username"
              type="text"
              autoComplete="username"
              aria-describedby={registering ? "registration-login-hint" : undefined}
              minLength={registering ? 3 : undefined}
              maxLength={64}
              required
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              disabled={busy}
              value={loginValue}
              onChange={(event) => setLoginValue(event.target.value)}
            />
          </div>
          <PasswordField
            id={registering ? "new-password" : "current-password"}
            name={registering ? "new-password" : "current-password"}
            label={t("password")}
            hint={registering ? t("passwordHint") : undefined}
            autoComplete={registering ? "new-password" : "current-password"}
            minLength={registering ? 12 : undefined}
            disabled={busy}
            value={password}
            onChange={setPassword}
            showLabel={t("showPassword")}
            hideLabel={t("hidePassword")}
          />
          <button className="auth-primary-button" type="submit" disabled={busy}>
            {busy ? t("working") : t(registering ? "createAccount" : "signIn")}
          </button>
        </form>
        {registrationEnabled ? (
          <p className="auth-switch-view">
            {t(registering ? "alreadyRegistered" : "needAccount")} {" "}
            <button
              type="button"
              onClick={() => {
                setView(registering ? "login" : "register");
                setPassword("");
                setError(undefined);
              }}
            >
              {t(registering ? "openSignIn" : "openRegistration")}
            </button>
          </p>
        ) : null}
      </section>
    </AuthPage>
  );
}

export function PendingScreen({ locale, login, onLocaleChange, onReturn }: {
  locale: Locale;
  login: string;
  onLocaleChange: (locale: Locale) => void;
  onReturn: () => void;
}) {
  return (
    <AuthPage locale={locale} onLocaleChange={onLocaleChange}>
      <div className="auth-state-card">
        <h1>{authText(locale, "pendingTitle")}</h1>
        <p>{authText(locale, "pendingHelp")}</p>
        <dl className="auth-pending-login">
          <dt>{authText(locale, "pendingLogin")}</dt>
          <dd>{login}</dd>
        </dl>
        <button type="button" className="auth-primary-button" onClick={onReturn}>
          {authText(locale, "checkAgain")}
        </button>
      </div>
    </AuthPage>
  );
}

export function ChangePasswordScreen({ locale, onChange, onLocaleChange, login }: {
  locale: Locale;
  login: string;
  onChange: (currentPassword: string, newPassword: string) => Promise<void>;
  onLocaleChange: (locale: Locale) => void;
}) {
  return (
    <AuthPage locale={locale} onLocaleChange={onLocaleChange}>
      <section className="auth-card" aria-labelledby="forced-password-title">
        <header className="auth-card-header">
          <div>
            <p className="auth-eyebrow">{login}</p>
            <h1 id="forced-password-title">{authText(locale, "forcedTitle")}</h1>
          </div>
        </header>
        <p className="auth-card-help">{authText(locale, "forcedHelp")}</p>
        <PasswordChangeForm locale={locale} onChange={onChange} submitLabel={authText(locale, "changePassword")} />
      </section>
    </AuthPage>
  );
}

export function PasswordChangeForm({ locale, onChange, submitLabel }: {
  locale: Locale;
  onChange: (currentPassword: string, newPassword: string) => Promise<void>;
  submitLabel: string;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = (key: Parameters<typeof authText>[1]) => authText(locale, key);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onChange(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
    } catch (cause) {
      setError(errorMessage(locale, cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {error ? <p className="auth-form-error" role="alert">{error}</p> : null}
      <PasswordField
        id="password-change-current"
        name="current-password"
        label={t("currentPassword")}
        autoComplete="current-password"
        disabled={busy}
        value={currentPassword}
        onChange={setCurrentPassword}
        showLabel={t("showPassword")}
        hideLabel={t("hidePassword")}
      />
      <PasswordField
        id="password-change-new"
        name="new-password"
        label={t("newPassword")}
        hint={t("passwordHint")}
        autoComplete="new-password"
        minLength={12}
        disabled={busy}
        value={newPassword}
        onChange={setNewPassword}
        showLabel={t("showPassword")}
        hideLabel={t("hidePassword")}
      />
      <button className="auth-primary-button" type="submit" disabled={busy}>
        {busy ? t("working") : submitLabel}
      </button>
    </form>
  );
}

function AuthPage({ children, languageLocked = false, locale, onLocaleChange }: {
  children: React.ReactNode;
  languageLocked?: boolean;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  return (
    <main className="auth-gate">
      {!languageLocked ? (
        <label className="auth-language">
          <span className="sr-only">{authText(locale, "language")}</span>
          <select
            value={locale}
            onChange={(event) => {
              const next = event.target.value as Locale;
              storeLocale(next);
              onLocaleChange(next);
            }}
          >
            {supportedLocales.map((item) => <option key={item} value={item}>{localeNames[item]}</option>)}
          </select>
        </label>
      ) : null}
      <div className="auth-page-content">{children}</div>
    </main>
  );
}

function errorMessage(locale: Locale, cause: unknown): string {
  return cause instanceof AuthApiError
    ? authErrorText(locale, cause.code)
    : authText(locale, "errorGeneric");
}
