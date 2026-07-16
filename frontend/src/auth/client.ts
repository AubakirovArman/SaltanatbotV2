import { publishAuthSessionInvalidated } from "./sessionSync";
import type {
  AdminAuditEvent,
  AdminAuditFilters,
  AdminAuditPage,
  AdminAuditState,
  AdminMutationResult,
  AdminUserFilters,
  AdminUserPage,
  AuthConfig,
  DisableMutation,
  AuthSession,
  AuthSessionPage,
  AuthSessionSummary,
  AuthUser,
  LifecycleMutation,
  Pagination,
  PermissionUpdate,
  RegistrationResult,
  SessionRevocationOutcome
} from "./types";

const csrfCookieName = "sbv2_csrf";
const legacyOfflineConfigKey = "sbv2:auth-config:legacy:v1";
let responseCsrfToken: string | undefined;

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export async function getAuthConfig(): Promise<AuthConfig> {
  let response: Response;
  try {
    response = await fetch("/api/auth/config", { credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (hasRememberedLegacyConfig()) {
      return { mode: "legacy", authRequired: false, registrationEnabled: false, tradingRoleAssignmentsEnabled: false };
    }
    throw error;
  }
  if (response.status === 404) {
    const legacy = { mode: "legacy", authRequired: false, registrationEnabled: false, tradingRoleAssignmentsEnabled: false } as const;
    rememberLegacyConfig(true);
    return legacy;
  }
  const body = await readResponse(response);
  const config: AuthConfig = {
    mode: stringValue(body.mode) ?? "database",
    authRequired: body.authRequired === true,
    registrationEnabled: body.registrationEnabled === true,
    tradingRoleAssignmentsEnabled: body.tradingRoleAssignmentsEnabled === true
  };
  rememberLegacyConfig(config.mode === "legacy" && !config.authRequired);
  return config;
}

export async function getCurrentSession(): Promise<AuthSession | undefined> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return undefined;
  const body = await readResponse(response);
  return sessionFromBody(body);
}

export async function login(loginValue: string, password: string): Promise<AuthSession> {
  const body = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ login: loginValue, password })
  });
  return sessionFromBody(body);
}

export async function register(loginValue: string, password: string): Promise<RegistrationResult> {
  const body = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ login: loginValue, password })
  });
  const user = objectValue(body.user);
  return {
    login: stringValue(user?.login) ?? loginValue.trim(),
    status: "pending"
  };
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" }, true);
  responseCsrfToken = undefined;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword })
  }, true);
  responseCsrfToken = undefined;
}

export async function listUsers(filters: AdminUserFilters = {}): Promise<AdminUserPage> {
  const body = await request(withQuery("/api/admin/users", filters), { method: "GET" });
  const users = Array.isArray(body.users) ? body.users : [];
  return {
    users: users.map(userFrom),
    pagination: paginationFrom(body, users.length, filters)
  };
}

export async function activateUser(userId: string, mutation: LifecycleMutation, reactivate = false): Promise<AdminMutationResult> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/${reactivate ? "reactivate" : "activate"}`, {
    method: "POST",
    body: JSON.stringify(mutation)
  });
}

export async function disableUser(userId: string, mutation: DisableMutation): Promise<AdminMutationResult> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
    body: JSON.stringify({
      reason: mutation.reason,
      expectedAuthorizationRevision: mutation.expectedAuthorizationRevision
    })
  });
}

export async function updateUserPermissions(userId: string, permissions: PermissionUpdate): Promise<AdminMutationResult> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: "PATCH",
    body: JSON.stringify(permissions)
  });
}

export async function listOwnSessions(page = 1, pageSize = 25): Promise<AuthSessionPage> {
  return sessionPageFrom(await request(withQuery("/api/auth/sessions", { page, pageSize }), { method: "GET" }), { page, pageSize });
}

export async function revokeOwnSession(publicId: string): Promise<SessionRevocationOutcome> {
  return sessionRevocationFrom(await request(`/api/auth/sessions/${encodeURIComponent(publicId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason: "Self-service session revocation." })
  }, true));
}

export async function revokeOtherSessions(): Promise<SessionRevocationOutcome> {
  return sessionRevocationFrom(await request("/api/auth/sessions/revoke-others", {
    method: "POST",
    body: JSON.stringify({ reason: "Self-service revocation of other sessions." })
  }, true));
}

export async function listAdminUserSessions(userId: string, page = 1, pageSize = 25): Promise<AuthSessionPage> {
  return sessionPageFrom(
    await request(withQuery(`/api/admin/users/${encodeURIComponent(userId)}/sessions`, { page, pageSize }), { method: "GET" }),
    { page, pageSize }
  );
}

export async function revokeAdminUserSession(userId: string, publicId: string, reason: string): Promise<SessionRevocationOutcome> {
  return sessionRevocationFrom(await request(`/api/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(publicId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason })
  }, true));
}

export async function revokeAllAdminUserSessions(userId: string, reason: string): Promise<SessionRevocationOutcome> {
  return sessionRevocationFrom(await request(`/api/admin/users/${encodeURIComponent(userId)}/sessions/revoke-all`, {
    method: "POST",
    body: JSON.stringify({ reason })
  }, true));
}

export async function listAdminAudit(filters: AdminAuditFilters = {}): Promise<AdminAuditPage> {
  if (filters.subjectUserId && !isUuid(filters.subjectUserId)) {
    throw new AuthApiError(400, "invalid_user_id", "Invalid user identifier.");
  }
  const body = await request(withQuery("/api/admin/audit", filters), { method: "GET" });
  const events = Array.isArray(body.events) ? body.events.map(auditEventFrom).filter((event): event is AdminAuditEvent => event !== undefined) : [];
  return {
    events,
    pagination: paginationFrom(body, events.length, filters)
  };
}

export function getCsrfToken(): string | undefined {
  return responseCsrfToken ?? readCookie(csrfCookieName);
}

async function userMutation(path: string, init: RequestInit): Promise<AdminMutationResult> {
  const body = await request(path, init, true);
  return {
    user: userFrom(body.user),
    revokedSessionCount: nonNegativeInteger(body.revokedSessionCount) ?? 0,
    cancelledJobCount: nonNegativeInteger(body.cancelledJobCount) ?? 0,
    revokedCurrentSession: requiredBoolean(body.revokedCurrentSession, "revokedCurrentSession")
  };
}

function sessionRevocationFrom(body: Record<string, unknown>): SessionRevocationOutcome {
  const outcome = {
    revokedSessionCount: nonNegativeInteger(body.revokedSessionCount) ?? 0,
    revokedCurrentSession: body.revokedCurrentSession === true
  };
  if (outcome.revokedCurrentSession) {
    responseCsrfToken = undefined;
    publishAuthSessionInvalidated();
  }
  return outcome;
}

async function request(path: string, init: RequestInit, csrf = false): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrf) {
    const token = getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  return readResponse(response, path);
}

async function readResponse(response: Response, requestPath?: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    const parsed: unknown = await response.json().catch(() => undefined);
    body = objectValue(parsed) ?? {};
  }
  const csrf = stringValue(body.csrfToken);
  if (csrf) responseCsrfToken = csrf;
  if (!response.ok) {
    const code = stringValue(body.code) ?? `http_${response.status}`;
    if (response.status === 401 && code !== "invalid_credentials" && code !== "invalid_current_password" && requestPath !== "/api/auth/login") {
      publishAuthSessionInvalidated();
    }
    throw new AuthApiError(
      response.status,
      code,
      stringValue(body.error) ?? stringValue(body.message) ?? `Request failed with status ${response.status}.`
    );
  }
  return body;
}

function sessionFromBody(body: Record<string, unknown>): AuthSession {
  return {
    user: userFrom(body.user),
    csrfToken: stringValue(body.csrfToken),
    expiresAt: stringValue(body.expiresAt),
    tradingAvailable: body.tradingAvailable === true
  };
}

function userFrom(value: unknown): AuthUser {
  const user = objectValue(value);
  if (!user || !stringValue(user.id) || !stringValue(user.login)) {
    throw new AuthApiError(500, "invalid_response", "Invalid authentication response.");
  }
  return {
    ...user,
    id: stringValue(user.id)!,
    login: stringValue(user.login)!,
    status: user.status === "pending" || user.status === "disabled" ? user.status : "active",
    appRole: user.appRole === "admin" ? "admin" : "user",
    tradingRole: user.tradingRole === "read-only" || user.tradingRole === "paper-trade" || user.tradingRole === "live-trade" ? user.tradingRole : "none",
    mustChangePassword: user.mustChangePassword === true,
    authorizationRevision: positiveInteger(user.authorizationRevision) ?? 1
  } as AuthUser;
}

function sessionPageFrom(body: Record<string, unknown>, fallback: { page: number; pageSize: number }): AuthSessionPage {
  const sessions = Array.isArray(body.sessions) ? body.sessions.map(sessionFrom).filter((session): session is AuthSessionSummary => session !== undefined) : [];
  return {
    sessions,
    pagination: paginationFrom(body, sessions.length, fallback),
    revocableSessionCount: nonNegativeInteger(body.revocableSessionCount) ?? sessions.filter((session) => !session.revokedAt).length
  };
}

function sessionFrom(value: unknown): AuthSessionSummary | undefined {
  const session = objectValue(value);
  const publicId = stringValue(session?.publicId);
  const createdAt = stringValue(session?.createdAt);
  const lastSeenAt = stringValue(session?.lastSeenAt);
  const expiresAt = stringValue(session?.expiresAt);
  if (!session || !publicId || !createdAt || !lastSeenAt || !expiresAt) return undefined;
  return {
    publicId,
    current: session.current === true,
    createdAt,
    lastSeenAt,
    expiresAt,
    revokedAt: stringValue(session.revokedAt),
    revokeReason: stringValue(session.revokeReason),
    userAgent: stringValue(session.userAgent),
    ipAddress: stringValue(session.ipAddress)
  };
}

function auditEventFrom(value: unknown): AdminAuditEvent | undefined {
  const event = objectValue(value);
  const rawId = event?.id;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : stringValue(rawId);
  const eventType = stringValue(event?.eventType);
  const occurredAt = stringValue(event?.occurredAt);
  if (!event || !id || !eventType || !occurredAt) return undefined;
  return {
    id,
    eventType,
    actorUserId: stringValue(event.actorUserId),
    actorLogin: stringValue(event.actorLogin),
    subjectUserId: stringValue(event.subjectUserId),
    subjectLogin: stringValue(event.subjectLogin),
    requestId: stringValue(event.requestId),
    ipAddress: stringValue(event.ipAddress),
    userAgent: stringValue(event.userAgent),
    reason: stringValue(event.reason),
    before: auditStateFrom(event.before),
    after: auditStateFrom(event.after),
    metadata: objectValue(event.metadata) ?? {},
    occurredAt
  };
}

function auditStateFrom(value: unknown): AdminAuditState | undefined {
  const state = objectValue(value);
  if (!state) return undefined;
  const result: AdminAuditState = {};
  if (state.status === "pending" || state.status === "active" || state.status === "disabled") result.status = state.status;
  if (state.appRole === "user" || state.appRole === "admin") result.appRole = state.appRole;
  if (state.tradingRole === "none" || state.tradingRole === "read-only" || state.tradingRole === "paper-trade" || state.tradingRole === "live-trade") result.tradingRole = state.tradingRole;
  const revision = positiveInteger(state.authorizationRevision);
  if (revision) result.authorizationRevision = revision;
  return Object.keys(result).length ? result : undefined;
}

function paginationFrom(body: Record<string, unknown>, itemCount: number, fallback: { page?: number; pageSize?: number }): Pagination {
  const nested = objectValue(body.pagination);
  const source = nested ?? body;
  const page = positiveInteger(source.page) ?? positiveInteger(fallback.page) ?? 1;
  const pageSize = positiveInteger(source.pageSize) ?? positiveInteger(fallback.pageSize) ?? Math.max(1, itemCount);
  const total = nonNegativeInteger(source.total) ?? itemCount;
  return {
    page,
    pageSize,
    total,
    totalPages: nonNegativeInteger(source.totalPages) ?? (total === 0 ? 0 : Math.ceil(total / pageSize))
  };
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "" || value === "all") continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AuthApiError(500, "invalid_response", `Invalid ${field} in authentication response.`);
  }
  return value;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hasRememberedLegacyConfig(): boolean {
  try {
    return localStorage.getItem(legacyOfflineConfigKey) === "1";
  } catch {
    return false;
  }
}

function rememberLegacyConfig(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(legacyOfflineConfigKey, "1");
    else localStorage.removeItem(legacyOfflineConfigKey);
  } catch {
    // Offline fallback remains optional when storage is unavailable.
  }
}
