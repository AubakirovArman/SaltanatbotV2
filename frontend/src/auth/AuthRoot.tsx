import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadLocale, supportedLocales, type Locale } from "../i18n";
import { AccountDialog, AccountLauncher } from "./AccountDialog";
import {
  AuthLoadingScreen,
  AuthUnavailableScreen,
  ChangePasswordScreen,
  PendingScreen,
  SignInScreen
} from "./AuthScreens";
import {
  AuthApiError,
  changePassword,
  getAuthConfig,
  getCurrentSession,
  login,
  logout,
  register
} from "./client";
import { authText, loadAuthMessages } from "./messages";
import type { AuthConfig, AuthSession, AuthUser } from "./types";

export interface AuthContextValue {
  authRequired: boolean;
  config?: AuthConfig;
  expiresAt?: string;
  openAccount: () => void;
  refreshSession: () => Promise<AuthSession | undefined>;
  tradingRoleAssignmentsEnabled: boolean;
  tradingAvailable: boolean;
  user?: AuthUser;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthRoot.");
  return value;
}

export function AuthRoot({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(loadLocale);
  const [catalogReady, setCatalogReady] = useState(false);
  const [config, setConfig] = useState<AuthConfig>();
  const [session, setSession] = useState<AuthSession>();
  const [pendingLogin, setPendingLogin] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let active = true;
    void loadAuthMessages(locale).finally(() => {
      if (active) setCatalogReady(true);
    });
    return () => { active = false; };
  }, [locale]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.lang as Locale;
      if (supportedLocales.includes(next) && next !== locale) setLocale(next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, [locale]);

  useEffect(() => {
    let active = true;
    setBootstrapFailed(false);
    setConfig(undefined);
    setSession(undefined);
    void (async () => {
      try {
        const nextConfig = await getAuthConfig();
        if (!active) return;
        setConfig(nextConfig);
        if (!nextConfig.authRequired) return;
        const nextSession = await getCurrentSession();
        if (active) setSession(nextSession);
      } catch {
        if (active) setBootstrapFailed(true);
      }
    })();
    return () => { active = false; };
  }, [bootstrapVersion]);

  const refreshSession = useCallback(async () => {
    const next = await getCurrentSession();
    setSession(next);
    if (!next) setAccountOpen(false);
    return next;
  }, []);

  useEffect(() => {
    if (!config?.authRequired || !session) return;
    let active = true;
    const refreshSilently = () => {
      void getCurrentSession().then((next) => {
        if (!active) return;
        setSession(next);
        if (!next) setAccountOpen(false);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refreshSilently, 5 * 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshSilently();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [config?.authRequired, session?.user.id]);

  const authValue = useMemo<AuthContextValue>(() => ({
    authRequired: config?.authRequired === true,
    config,
    expiresAt: session?.expiresAt,
    openAccount: () => setAccountOpen(true),
    refreshSession,
    tradingRoleAssignmentsEnabled: config?.tradingRoleAssignmentsEnabled === true,
    tradingAvailable: session?.tradingAvailable === true,
    user: session?.user
  }), [config, refreshSession, session]);

  if (!catalogReady) return <AuthLoadingScreen locale={locale} />;

  if (bootstrapFailed) {
    return (
      <AuthUnavailableScreen
        locale={locale}
        onLocaleChange={setLocale}
        onRetry={() => setBootstrapVersion((current) => current + 1)}
      />
    );
  }

  if (!config) return <AuthLoadingScreen locale={locale} />;

  if (!config.authRequired) {
    return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
  }

  if (!session) {
    if (pendingLogin) {
      return (
        <PendingScreen
          locale={locale}
          login={pendingLogin}
          onLocaleChange={setLocale}
          onReturn={() => setPendingLogin(undefined)}
        />
      );
    }
    return (
      <SignInScreen
        locale={locale}
        notice={notice}
        onLocaleChange={setLocale}
        registrationEnabled={config.registrationEnabled}
        onLogin={async (loginValue, password) => {
          setNotice(undefined);
          try {
            const next = await login(loginValue, password);
            setSession(next);
            authChanged("login");
          } catch (cause) {
            if (cause instanceof AuthApiError && cause.code === "pending_approval") {
              setPendingLogin(loginValue.trim());
              return;
            }
            throw cause;
          }
        }}
        onRegister={async (loginValue, password) => {
          const result = await register(loginValue, password);
          setPendingLogin(result.login);
        }}
      />
    );
  }

  const replacePassword = async (currentPassword: string, newPassword: string) => {
    await changePassword(currentPassword, newPassword);
    setAccountOpen(false);
    setSession(undefined);
    setNotice(authText(locale, "passwordChanged"));
    authChanged("logout");
  };

  if (session.user.mustChangePassword) {
    return (
      <ChangePasswordScreen
        locale={locale}
        login={session.user.login}
        onLocaleChange={setLocale}
        onChange={replacePassword}
      />
    );
  }

  return (
    <AuthContext.Provider value={authValue}>
      {children}
      <AccountLauncher locale={locale} user={session.user} onOpen={() => setAccountOpen(true)} />
      <AccountDialog
        locale={locale}
        open={accountOpen}
        user={session.user}
        tradingRoleAssignmentsEnabled={config.tradingRoleAssignmentsEnabled}
        onClose={() => setAccountOpen(false)}
        onChangePassword={replacePassword}
        onLogout={async () => {
          await logout();
          setAccountOpen(false);
          setSession(undefined);
          authChanged("logout");
        }}
      />
    </AuthContext.Provider>
  );
}

function authChanged(detail: "login" | "logout"): void {
  window.dispatchEvent(new CustomEvent("sbv2:auth-changed", { detail }));
}
