import type { Locale } from "../i18n";

interface AuthMessages {
  product: string; eyebrow: string; signInTitle: string; signInHelp: string;
  registerTitle: string; registerHelp: string; login: string; loginHint: string;
  password: string; currentPassword: string; newPassword: string; passwordHint: string;
  showPassword: string; hidePassword: string; signIn: string; createAccount: string;
  needAccount: string; alreadyRegistered: string; openRegistration: string; openSignIn: string;
  language: string; loading: string; serviceUnavailableTitle: string; serviceUnavailableHelp: string;
  retry: string; pendingTitle: string; pendingHelp: string; pendingLogin: string; checkAgain: string;
  forcedTitle: string; forcedHelp: string; changePassword: string; passwordChanged: string;
  account: string; close: string; signOut: string; status: string; appRole: string; tradingRole: string;
  userRole: string; adminRole: string; noTrading: string; readOnly: string; paperTrade: string;
  liveTrade: string; active: string; pending: string; disabled: string; securityTitle: string;
  securityHelp: string; usersTitle: string; usersHelp: string; tradingMigrationPending: string;
  reloadUsers: string; noUsers: string; activate: string; disable: string; savePermissions: string;
  permissionsSaved: string; userActivated: string; userDisabled: string; working: string;
  adminArea: string; accountArea: string; errorGeneric: string; errorInvalidCredentials: string;
  errorPending: string; errorDisabled: string; errorRateLimited: string; errorLoginExists: string;
  errorInvalidLogin: string; errorPasswordPolicy: string; errorCurrentPassword: string;
}

export type AuthMessageKey = keyof AuthMessages;
const catalogs = new Map<Locale, AuthMessages>();

export async function loadAuthMessages(locale: Locale): Promise<void> {
  if (catalogs.has(locale)) return;
  const catalog = await fetchCatalog(locale).catch(() => locale === "en" ? undefined : fetchCatalog("en").catch(() => undefined));
  if (catalog) catalogs.set(locale, catalog);
}

export function hasAuthMessages(locale: Locale): boolean {
  return catalogs.has(locale);
}

export function authText(locale: Locale, key: AuthMessageKey): string {
  return catalogs.get(locale)?.[key] ?? fallback(key);
}

export function authErrorText(locale: Locale, code: string): string {
  const keys: Record<string, AuthMessageKey> = {
    invalid_credentials: "errorInvalidCredentials",
    pending_approval: "errorPending",
    account_disabled: "errorDisabled",
    rate_limited: "errorRateLimited",
    login_exists: "errorLoginExists",
    invalid_login: "errorInvalidLogin",
    password_policy: "errorPasswordPolicy",
    invalid_current_password: "errorCurrentPassword",
    password_reused: "errorPasswordPolicy"
  };
  return authText(locale, keys[code] ?? "errorGeneric");
}

async function fetchCatalog(locale: Locale): Promise<AuthMessages> {
  const response = await fetch(`/auth-i18n/${locale}.json`, { cache: "force-cache" });
  if (!response.ok) throw new Error("auth_catalog_unavailable");
  return await response.json() as AuthMessages;
}

function fallback(key: AuthMessageKey): string {
  if (key === "product") return "SaltanatbotV2";
  if (key === "loading") return "Loading…";
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
}
