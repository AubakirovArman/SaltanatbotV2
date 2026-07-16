import type { Locale } from "../i18n";

interface AuthMessages {
  product: string;
  eyebrow: string;
  signInTitle: string;
  signInHelp: string;
  registerTitle: string;
  registerHelp: string;
  login: string;
  loginHint: string;
  password: string;
  currentPassword: string;
  newPassword: string;
  passwordHint: string;
  showPassword: string;
  hidePassword: string;
  signIn: string;
  createAccount: string;
  needAccount: string;
  alreadyRegistered: string;
  openRegistration: string;
  openSignIn: string;
  language: string;
  loading: string;
  serviceUnavailableTitle: string;
  serviceUnavailableHelp: string;
  retry: string;
  pendingTitle: string;
  pendingHelp: string;
  pendingLogin: string;
  checkAgain: string;
  forcedTitle: string;
  forcedHelp: string;
  changePassword: string;
  passwordChanged: string;
  account: string;
  close: string;
  signOut: string;
  status: string;
  appRole: string;
  tradingRole: string;
  userRole: string;
  adminRole: string;
  noTrading: string;
  readOnly: string;
  paperTrade: string;
  liveTrade: string;
  active: string;
  pending: string;
  disabled: string;
  securityTitle: string;
  securityHelp: string;
  usersTitle: string;
  usersHelp: string;
  tradingMigrationPending: string;
  reloadUsers: string;
  noUsers: string;
  activate: string;
  disable: string;
  savePermissions: string;
  permissionsSaved: string;
  userActivated: string;
  userDisabled: string;
  working: string;
  userFilters: string;
  searchUsers: string;
  searchUsersHint: string;
  filterStatus: string;
  allStatuses: string;
  usersShown: string;
  noMatchingUsers: string;
  permissionsForUser: string;
  ownAdminRoleLocked: string;
  saveAndActivate: string;
  userActivatedWithPermissions: string;
  activationFailedAfterPermissions: string;
  adminArea: string;
  accountArea: string;
  sessionsTitle: string;
  sessionsHelp: string;
  currentSession: string;
  sessionCreated: string;
  sessionLastSeen: string;
  sessionExpires: string;
  sessionDevice: string;
  sessionIp: string;
  unknownDevice: string;
  revokeSession: string;
  revokeOtherSessions: string;
  noOtherSessions: string;
  noSessions: string;
  sessionsRevoked: string;
  sessionRevoked: string;
  sessionRevocationWarning: string;
  previousPage: string;
  nextPage: string;
  pageOf: string;
  usersTab: string;
  auditTab: string;
  filterAppRole: string;
  filterTradingRole: string;
  allRoles: string;
  applyFilters: string;
  clearFilters: string;
  createdAt: string;
  lastLoginAt: string;
  approvedAt: string;
  never: string;
  dormantLiveTrade: string;
  dormantLiveTradeHelp: string;
  reason: string;
  reasonHint: string;
  reasonRequired: string;
  reviewChange: string;
  confirmAction: string;
  cancel: string;
  before: string;
  after: string;
  reactivate: string;
  userReactivated: string;
  permissionImpact: string;
  sessionsForUser: string;
  viewSessions: string;
  hideSessions: string;
  revokeAllSessions: string;
  adminSessionReason: string;
  auditTitle: string;
  auditHelp: string;
  auditEvent: string;
  auditActor: string;
  auditSubject: string;
  auditSubjectHint: string;
  auditReason: string;
  auditChanges: string;
  auditNoEvents: string;
  auditEventFilter: string;
  auditAllEvents: string;
  auditRequestId: string;
  systemActor: string;
  sessionsClosed: string;
  jobsCancelled: string;
  errorGeneric: string;
  errorInvalidCredentials: string;
  errorPending: string;
  errorDisabled: string;
  errorRateLimited: string;
  errorLoginExists: string;
  errorInvalidLogin: string;
  errorPasswordPolicy: string;
  errorCurrentPassword: string;
  errorSelfDisable: string;
  errorSelfDemote: string;
  errorLastAdmin: string;
  errorPasswordChangeRequired: string;
  errorUserNotFound: string;
  errorInvalidReason: string;
  errorStaleUser: string;
  errorLiveRoleForbidden: string;
  errorInvalidCsrf: string;
  errorNotAuthenticated: string;
  errorRegistrationDisabled: string;
  errorAuthBusy: string;
  errorSessionNotFound: string;
  errorAdminRequired: string;
  errorInvalidTransition: string;
  errorInvalidRequest: string;
  errorInvalidUserId: string;
  errorInvalidQuery: string;
  errorInvalidPagination: string;
}

export type AuthMessageKey = keyof AuthMessages;
const catalogs = new Map<Locale, AuthMessages>();

export async function loadAuthMessages(locale: Locale): Promise<void> {
  if (catalogs.has(locale)) return;
  const catalog = await fetchCatalog(locale).catch(() => (locale === "en" ? undefined : fetchCatalog("en").catch(() => undefined)));
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
    password_reused: "errorPasswordPolicy",
    self_disable: "errorSelfDisable",
    self_demote: "errorSelfDemote",
    last_active_admin: "errorLastAdmin",
    password_change_required: "errorPasswordChangeRequired",
    actor_password_change_required: "errorPasswordChangeRequired",
    user_not_found: "errorUserNotFound",
    subject_not_found: "errorUserNotFound",
    invalid_reason: "errorInvalidReason",
    authorization_conflict: "errorStaleUser",
    invalid_authorization_revision: "errorStaleUser",
    stale_user: "errorStaleUser",
    invalid_user_transition: "errorInvalidTransition",
    live_trading_role_forbidden: "errorLiveRoleForbidden",
    invalid_csrf: "errorInvalidCsrf",
    not_authenticated: "errorNotAuthenticated",
    user_inactive: "errorNotAuthenticated",
    user_not_admin: "errorAdminRequired",
    admin_required: "errorAdminRequired",
    session_not_found: "errorSessionNotFound",
    trading_ownership_pending: "tradingMigrationPending",
    registration_disabled: "errorRegistrationDisabled",
    auth_busy: "errorAuthBusy",
    invalid_request: "errorInvalidRequest",
    invalid_user_id: "errorInvalidUserId",
    invalid_query: "errorInvalidQuery",
    invalid_pagination: "errorInvalidPagination"
  };
  return authText(locale, keys[code] ?? "errorGeneric");
}

async function fetchCatalog(locale: Locale): Promise<AuthMessages> {
  const response = await fetch(`/auth-i18n/${locale}.json`, { cache: "force-cache" });
  if (!response.ok) throw new Error("auth_catalog_unavailable");
  return (await response.json()) as AuthMessages;
}

function fallback(key: AuthMessageKey): string {
  if (key === "product") return "SaltanatbotV2";
  if (key === "loading") return "Loading…";
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
}
