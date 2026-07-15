import type { AuthConfig, AuthSession, AuthUser, PermissionUpdate, RegistrationResult } from "./types";

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

export async function listUsers(): Promise<AuthUser[]> {
  const body = await request("/api/admin/users", { method: "GET" });
  const users = Array.isArray(body.users) ? body.users : [];
  return users.map(userFrom);
}

export async function activateUser(userId: string): Promise<AuthUser> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/activate`, { method: "POST" });
}

export async function disableUser(userId: string): Promise<AuthUser> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/disable`, { method: "POST" });
}

export async function updateUserPermissions(userId: string, permissions: PermissionUpdate): Promise<AuthUser> {
  return userMutation(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: "PATCH",
    body: JSON.stringify(permissions)
  });
}

export function getCsrfToken(): string | undefined {
  return responseCsrfToken ?? readCookie(csrfCookieName);
}

async function userMutation(path: string, init: RequestInit): Promise<AuthUser> {
  const body = await request(path, init, true);
  return userFrom(body.user);
}

async function request(path: string, init: RequestInit, csrf = false): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrf) {
    const token = getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  return readResponse(response);
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    const parsed: unknown = await response.json().catch(() => undefined);
    body = objectValue(parsed) ?? {};
  }
  const csrf = stringValue(body.csrfToken);
  if (csrf) responseCsrfToken = csrf;
  if (!response.ok) {
    throw new AuthApiError(
      response.status,
      stringValue(body.code) ?? `http_${response.status}`,
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
  return user as unknown as AuthUser;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
