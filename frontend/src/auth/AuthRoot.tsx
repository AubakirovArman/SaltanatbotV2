import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { prepareTenantLocalStorageOwner } from "../app/tenantLocalStorage";
import { loadLocale, supportedLocales, type Locale } from "../i18n";
import { AccountDialog } from "./AccountDialog";
import { AuthLoadingScreen, AuthUnavailableScreen, ChangePasswordScreen, PendingScreen, SignInScreen } from "./AuthScreens";
import { AuthApiError, changePassword, getAuthConfig, getCurrentSession, login, logout, register } from "./client";
import { authText, loadAuthMessages } from "./messages";
import { publishAuthSessionChange, subscribeAuthSessionChanges, type AuthSessionChangeKind } from "./sessionSync";
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
  const sessionRef = useRef<AuthSession>();
  const sessionResolutionRef = useRef(0);

  const acceptSession = useCallback(async (next: AuthSession | undefined, resolution: number, isCurrent: () => boolean = () => true) => {
    if (!isCurrent() || resolution !== sessionResolutionRef.current) return false;
    if (next) {
      try {
        await prepareTenantLocalStorageOwner(window.localStorage, next.user.id);
      } catch {
        // Owner-scoped keys still fail closed when browser storage is unavailable.
      }
    }
    if (!isCurrent() || resolution !== sessionResolutionRef.current) return false;
    sessionRef.current = next;
    setSession(next);
    if (!next) setAccountOpen(false);
    return true;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let active = true;
    void loadAuthMessages(locale).finally(() => {
      if (active) setCatalogReady(true);
    });
    return () => {
      active = false;
    };
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
    const resolution = ++sessionResolutionRef.current;
    setBootstrapFailed(false);
    setConfig(undefined);
    sessionRef.current = undefined;
    setSession(undefined);
    void (async () => {
      try {
        const nextConfig = await getAuthConfig();
        if (!active) return;
        setConfig(nextConfig);
        if (!nextConfig.authRequired) return;
        const nextSession = await getCurrentSession();
        await acceptSession(nextSession, resolution, () => active);
      } catch {
        if (active) setBootstrapFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [acceptSession, bootstrapVersion]);

  const refreshSession = useCallback(async () => {
    const resolution = ++sessionResolutionRef.current;
    const previousUserId = sessionRef.current?.user.id;
    const next = await getCurrentSession();
    const accepted = await acceptSession(next, resolution);
    if (accepted && previousUserId !== next?.user.id) publishAuthSessionChange("session");
    return next;
  }, [acceptSession]);

  const reconcileAfterAuthMutation = useCallback(
    async (kind: AuthSessionChangeKind) => {
      publishAuthSessionChange(kind);
      const resolution = ++sessionResolutionRef.current;
      try {
        const next = await getCurrentSession();
        await acceptSession(next, resolution);
        return next;
      } catch (cause) {
        await acceptSession(undefined, resolution);
        throw cause;
      }
    },
    [acceptSession]
  );

  useEffect(() => {
    if (!config?.authRequired) return;
    let active = true;
    const unsubscribe = subscribeAuthSessionChanges(() => {
      const resolution = ++sessionResolutionRef.current;
      void getCurrentSession()
        .then((next) => acceptSession(next, resolution, () => active))
        .catch(() => acceptSession(undefined, resolution, () => active));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [acceptSession, config?.authRequired]);

  useEffect(() => {
    if (!config?.authRequired || !session) return;
    let active = true;
    const refreshSilently = () => {
      const resolution = ++sessionResolutionRef.current;
      const previousUserId = sessionRef.current?.user.id;
      void getCurrentSession()
        .then(async (next) => {
          const accepted = await acceptSession(next, resolution, () => active);
          if (accepted && previousUserId !== next?.user.id) publishAuthSessionChange("session");
        })
        .catch(() => undefined);
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
  }, [acceptSession, config?.authRequired, session?.user.id]);

  const authValue = useMemo<AuthContextValue>(
    () => ({
      authRequired: config?.authRequired === true,
      config,
      expiresAt: session?.expiresAt,
      openAccount: () => setAccountOpen(true),
      refreshSession,
      tradingRoleAssignmentsEnabled: config?.tradingRoleAssignmentsEnabled === true,
      tradingAvailable: session?.tradingAvailable === true,
      user: session?.user
    }),
    [config, refreshSession, session]
  );

  if (!catalogReady) return <AuthLoadingScreen locale={locale} />;

  if (bootstrapFailed) {
    return <AuthUnavailableScreen locale={locale} onLocaleChange={setLocale} onRetry={() => setBootstrapVersion((current) => current + 1)} />;
  }

  if (!config) return <AuthLoadingScreen locale={locale} />;

  if (!config.authRequired) {
    return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
  }

  if (!session) {
    if (pendingLogin) {
      return <PendingScreen locale={locale} login={pendingLogin} onLocaleChange={setLocale} onReturn={() => setPendingLogin(undefined)} />;
    }
    return (
      <SignInScreen
        locale={locale}
        notice={notice}
        onLocaleChange={setLocale}
        registrationEnabled={config.registrationEnabled}
        onLogin={async (loginValue, password) => {
          ++sessionResolutionRef.current;
          setNotice(undefined);
          try {
            await login(loginValue, password);
            await reconcileAfterAuthMutation("login");
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
    ++sessionResolutionRef.current;
    await changePassword(currentPassword, newPassword);
    setAccountOpen(false);
    setNotice(authText(locale, "passwordChanged"));
    await reconcileAfterAuthMutation("password");
  };

  if (session.user.mustChangePassword) {
    return <ChangePasswordScreen locale={locale} login={session.user.login} onLocaleChange={setLocale} onChange={replacePassword} />;
  }

  return (
    <AuthContext.Provider value={authValue}>
      <Fragment key={session.user.id}>{children}</Fragment>
      <AccountDialog
        locale={locale}
        open={accountOpen}
        user={session.user}
        tradingRoleAssignmentsEnabled={config.tradingRoleAssignmentsEnabled}
        onClose={() => setAccountOpen(false)}
        onChangePassword={replacePassword}
        onLogout={async () => {
          ++sessionResolutionRef.current;
          await logout();
          setAccountOpen(false);
          await reconcileAfterAuthMutation("logout");
        }}
      />
    </AuthContext.Provider>
  );
}
