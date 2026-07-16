import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { csrfFromRequest, principalFromRequest } from "./http.js";
import { PasswordHashCapacityError } from "./password.js";
import type { AuthRateLimitPolicy } from "./rateLimit.js";
import { uuidSchema } from "./routeSchemas.js";
import type { PublicRevocablePage } from "./identityServiceTypes.js";
import {
  IdentityError,
  type IdentityService,
  normalizeLogin,
  type AdminUserMutationOutcome,
  type PublicPage
} from "./service.js";
import type { IdentityPrincipal, UserStatus } from "./types.js";

export function asyncRoute(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction
  ) => Promise<unknown>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

export function identityRequestContext(
  _request: Request,
  response: Response,
  next: NextFunction
): void {
  const requestId = randomUUID();
  response.locals.identityRequestId = requestId;
  response.setHeader("X-Request-ID", requestId);
  response.setHeader("Cache-Control", "no-store");
  next();
}

export async function requirePrincipal(
  service: IdentityService,
  request: Request
): Promise<IdentityPrincipal> {
  const principal = await principalFromRequest(service, request);
  if (!principal) {
    throw new IdentityError(
      401,
      "not_authenticated",
      "Authentication is required."
    );
  }
  return principal;
}

export function requireCsrf(
  service: IdentityService,
  principal: IdentityPrincipal,
  request: Request
): void {
  if (!service.verifyCsrf(principal, csrfFromRequest(request))) {
    throw new IdentityError(
      403,
      "invalid_csrf",
      "Missing or invalid CSRF token."
    );
  }
}

export function tradingAvailable(
  service: IdentityService,
  user: IdentityPrincipal["user"]
): boolean {
  return (
    user.appRole === "admin" ||
    (service.allowNonAdminTrading && user.tradingRole !== "none")
  );
}

export function rateLimited(
  retryAfter: number | undefined,
  response: Response
): boolean {
  if (!retryAfter) return false;
  response.setHeader("Retry-After", String(retryAfter));
  response
    .status(429)
    .json({
      error: "Too many attempts. Try again later.",
      code: "rate_limited"
    });
  return true;
}

export function validationError(response: Response, details: unknown): void {
  response
    .status(400)
    .json({ error: "Invalid request.", code: "invalid_request", details });
}

export function parseStatus(value: unknown): UserStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "pending" || value === "active" || value === "disabled") {
    return value;
  }
  throw new IdentityError(
    400,
    "invalid_status",
    "Invalid user status filter."
  );
}

export function parseAppRole(
  value: unknown
): "user" | "admin" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "user" || value === "admin") return value;
  throw new IdentityError(
    400,
    "invalid_app_role",
    "Invalid application role filter."
  );
}

export function parseTradingRole(
  value: unknown
): "none" | "read-only" | "paper-trade" | "live-trade" | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value === "none" ||
    value === "read-only" ||
    value === "paper-trade" ||
    value === "live-trade"
  ) {
    return value;
  }
  throw new IdentityError(
    400,
    "invalid_trading_role",
    "Invalid trading role filter."
  );
}

export function pageRequest(
  request: Request
): { page: number; pageSize: number } {
  return {
    page: positiveQueryInteger(request.query.page, "page", 1, 1_000_000),
    pageSize: positiveQueryInteger(
      request.query.pageSize,
      "pageSize",
      25,
      100
    )
  };
}

export function optionalQuery(
  value: unknown,
  maximum: number
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") {
    throw new IdentityError(400, "invalid_query", "Invalid query filter.");
  }
  const normalized = text.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > maximum || containsControlCharacter(normalized)) {
    throw new IdentityError(400, "invalid_query", "Invalid query filter.");
  }
  return normalized;
}

export function optionalUuidQuery(value: unknown): string | undefined {
  const candidate = optionalQuery(value, 64);
  if (candidate === undefined) return undefined;
  const parsed = uuidSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new IdentityError(
      400,
      "invalid_user_id",
      "Invalid user identifier."
    );
  }
  return parsed.data;
}

export function pagedResponse<T>(
  key: "users" | "sessions" | "events",
  items: T[],
  page: PublicPage<T> | PublicRevocablePage<T>
): Record<string, unknown> {
  return {
    [key]: items,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
    pagination: page.pagination,
    ...("revocableSessionCount" in page
      ? { revocableSessionCount: page.revocableSessionCount }
      : {})
  };
}

export function adminMutationResponse(
  result: AdminUserMutationOutcome
): Record<string, unknown> {
  return {
    user: result.user,
    revokedSessionCount: result.revokedSessionCount,
    revokedCurrentSession: result.revokedCurrentSession,
    cancelledJobCount: result.cancelledJobCount
  };
}

export function routeId(request: Request): string {
  return routeParam(request, "id").toLowerCase();
}

export function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function identityErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction
): void {
  if (error instanceof PasswordHashCapacityError) {
    response.setHeader("Retry-After", "1");
    response
      .status(503)
      .json({
        error: "Authentication is temporarily unavailable. Try again later.",
        code: "auth_busy"
      });
    return;
  }
  if (!(error instanceof IdentityError)) {
    next(error);
    return;
  }
  response
    .status(error.status)
    .json({ error: error.message, code: error.code });
}

export function requestIpKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function loginIdentityKey(login: string): string {
  return createHash("sha256")
    .update(normalizeLogin(login))
    .digest("base64url");
}

export function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof IdentityError && error.code === "invalid_credentials"
  );
}

export function isProvenCredentialRejection(error: unknown): boolean {
  return (
    error instanceof IdentityError &&
    (error.code === "pending_approval" || error.code === "account_disabled")
  );
}

export function authRateLimitConfiguration(): {
  maxEntries: number;
  loginIp: AuthRateLimitPolicy;
  loginIdentity: AuthRateLimitPolicy;
  registrationIp: AuthRateLimitPolicy;
} {
  const loginWindowMs = boundedEnv(
    "AUTH_LOGIN_RATE_WINDOW_MS",
    15 * 60_000,
    60_000,
    24 * 60 * 60_000
  );
  const loginBlockMs = boundedEnv(
    "AUTH_LOGIN_RATE_BLOCK_MS",
    15 * 60_000,
    60_000,
    24 * 60 * 60_000
  );
  return {
    maxEntries: boundedEnv(
      "AUTH_RATE_LIMIT_MAX_ENTRIES",
      4_096,
      256,
      100_000
    ),
    loginIp: {
      windowMs: loginWindowMs,
      maxAttempts: boundedEnv(
        "AUTH_LOGIN_IP_MAX_FAILURES",
        30,
        3,
        10_000
      ),
      blockMs: loginBlockMs
    },
    loginIdentity: {
      windowMs: loginWindowMs,
      maxAttempts: boundedEnv(
        "AUTH_LOGIN_IDENTITY_MAX_FAILURES",
        10,
        3,
        1_000
      ),
      blockMs: loginBlockMs
    },
    registrationIp: {
      windowMs: boundedEnv(
        "AUTH_REGISTER_RATE_WINDOW_MS",
        60 * 60_000,
        60_000,
        7 * 24 * 60 * 60_000
      ),
      maxAttempts: boundedEnv(
        "AUTH_REGISTER_IP_MAX_ATTEMPTS",
        5,
        1,
        1_000
      ),
      blockMs: boundedEnv(
        "AUTH_REGISTER_RATE_BLOCK_MS",
        60 * 60_000,
        60_000,
        7 * 24 * 60 * 60_000
      )
    }
  };
}

function positiveQueryInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/u.test(text)) {
    throw new IdentityError(
      400,
      "invalid_pagination",
      `Invalid ${name} value.`
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new IdentityError(
      400,
      "invalid_pagination",
      `Invalid ${name} value.`
    );
  }
  return parsed;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function boundedEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback;
}
