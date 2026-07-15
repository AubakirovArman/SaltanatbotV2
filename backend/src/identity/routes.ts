import { createHash } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { PasswordHashCapacityError } from "./password.js";
import { AuthRateLimiter, BoundedAuthRateLimitStore, type AuthRateLimitPolicy } from "./rateLimit.js";
import { IdentityError, IdentityService, normalizeLogin } from "./service.js";
import { clearAuthCookies, csrfFromCookie, csrfFromRequest, principalFromRequest, requestMetadata, setAuthCookies } from "./http.js";
import type { IdentityPrincipal, UserStatus } from "./types.js";

const loginSchema = z
  .object({
    login: z.string().min(1).max(128),
    password: z.string().min(1).max(256)
  })
  .strict();

const registerSchema = loginSchema;
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(1).max(256)
  })
  .strict();
const permissionsSchema = z
  .object({
    appRole: z.enum(["user", "admin"]).optional(),
    tradingRole: z.enum(["none", "read-only", "paper-trade", "live-trade"]).optional()
  })
  .strict()
  .refine((value) => value.appRole !== undefined || value.tradingRole !== undefined);

export interface IdentityRouters {
  auth: Router;
  admin: Router;
}

export interface IdentityRouteProtectionOptions {
  store?: BoundedAuthRateLimitStore;
  loginIpPolicy?: AuthRateLimitPolicy;
  loginIdentityPolicy?: AuthRateLimitPolicy;
  registrationIpPolicy?: AuthRateLimitPolicy;
  now?: () => number;
}

export function createIdentityRouters(service: IdentityService, protection: IdentityRouteProtectionOptions = {}): IdentityRouters {
  const auth = Router();
  const admin = Router();
  const defaults = authRateLimitConfiguration();
  const store = protection.store ?? new BoundedAuthRateLimitStore(defaults.maxEntries);
  const loginIpLimiter = new AuthRateLimiter("login-ip", store, protection.loginIpPolicy ?? defaults.loginIp);
  const loginIdentityLimiter = new AuthRateLimiter("login-identity", store, protection.loginIdentityPolicy ?? defaults.loginIdentity);
  const registerLimiter = new AuthRateLimiter("registration-ip", store, protection.registrationIpPolicy ?? defaults.registrationIp);
  const now = protection.now ?? Date.now;
  const authJson = express.json({ limit: "32kb" });
  admin.use(express.json({ limit: "32kb" }));

  auth.get("/config", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      mode: "database",
      authRequired: true,
      registrationEnabled: service.allowRegistration,
      tradingRoleAssignmentsEnabled: service.allowNonAdminTrading
    });
  });

  auth.post(
    "/register",
    // Reserve the allowance before JSON parsing so malformed and oversized
    // attempts cannot bypass the stricter registration bucket.
    (request, response, next) => {
      if (!rateLimited(registerLimiter.attempt(requestIpKey(request), now()), response)) next();
    },
    authJson,
    asyncRoute(async (request, response) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) return validationError(response, parsed.error.flatten());
      const user = await service.register(parsed.data.login, parsed.data.password, requestMetadata(request));
      response.status(202).json({ ok: true, status: "pending", user: { id: user.id, login: user.login } });
    })
  );

  auth.use(authJson);

  auth.post(
    "/login",
    asyncRoute(async (request, response) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return validationError(response, parsed.error.flatten());
      const ipKey = requestIpKey(request);
      const identityKey = loginIdentityKey(parsed.data.login);
      const reservedAt = now();
      // These synchronous reservations happen before the first await. Parallel
      // login requests therefore consume both buckets before password hashing
      // starts instead of all passing a check against stale failure counts.
      const ipReservation = loginIpLimiter.reserve(ipKey, reservedAt);
      if (rateLimited(ipReservation.retryAfter, response)) return;
      const identityReservation = loginIdentityLimiter.reserve(identityKey, reservedAt);
      if (rateLimited(identityReservation.retryAfter, response)) {
        ipReservation.rollback();
        return;
      }
      try {
        const credentials = await service.login(parsed.data.login, parsed.data.password, requestMetadata(request));
        // Refund only this successful request's IP reservation, preserving any
        // earlier failures from that IP. A proven credential may safely clear
        // failures for its own identity.
        ipReservation.rollback();
        loginIdentityLimiter.success(identityKey);
        setAuthCookies(response, credentials);
        response.setHeader("Cache-Control", "no-store");
        response.json({
          ok: true,
          csrfToken: credentials.csrfToken,
          expiresAt: credentials.expiresAt.toISOString(),
          user: credentials.user,
          tradingAvailable: tradingAvailable(service, credentials.user)
        });
      } catch (error) {
        if (!isCredentialFailure(error)) {
          ipReservation.rollback();
          if (isProvenCredentialRejection(error)) loginIdentityLimiter.success(identityKey);
          else identityReservation.rollback();
        }
        throw error;
      }
    })
  );

  auth.get(
    "/me",
    asyncRoute(async (request, response) => {
      const principal = await principalFromRequest(service, request);
      if (!principal) throw new IdentityError(401, "not_authenticated", "Authentication is required.");
      const csrfToken = csrfFromCookie(request);
      response.setHeader("Cache-Control", "no-store");
      response.json({
        ok: true,
        csrfToken: csrfToken && service.verifyCsrf(principal, csrfToken) ? csrfToken : undefined,
        expiresAt: principal.expiresAt.toISOString(),
        user: principal.user,
        tradingAvailable: tradingAvailable(service, principal.user)
      });
    })
  );

  auth.post(
    "/logout",
    asyncRoute(async (request, response) => {
      const principal = await requirePrincipal(service, request);
      requireCsrf(service, principal, request);
      await service.logout(principal, requestMetadata(request));
      clearAuthCookies(response);
      response.json({ ok: true });
    })
  );

  auth.post(
    "/change-password",
    asyncRoute(async (request, response) => {
      const principal = await requirePrincipal(service, request);
      requireCsrf(service, principal, request);
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) return validationError(response, parsed.error.flatten());
      await service.changePassword(principal, parsed.data.currentPassword, parsed.data.newPassword, requestMetadata(request));
      clearAuthCookies(response);
      response.json({ ok: true, reloginRequired: true });
    })
  );

  admin.use(
    asyncRoute(async (request, response, next) => {
      const principal = await requirePrincipal(service, request);
      if (principal.user.mustChangePassword) {
        throw new IdentityError(403, "password_change_required", "Change the temporary password before using administrator functions.");
      }
      if (principal.user.appRole !== "admin") throw new IdentityError(403, "admin_required", "Administrator access is required.");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) requireCsrf(service, principal, request);
      response.locals.authPrincipal = principal;
      next();
    })
  );

  admin.get(
    "/users",
    asyncRoute(async (request, response) => {
      const status = parseStatus(request.query.status);
      response.json({ users: await service.listUsers(response.locals.authPrincipal as IdentityPrincipal, status) });
    })
  );

  admin.post(
    "/users/:id/activate",
    asyncRoute(async (request, response) => {
      const user = await service.activateUser(response.locals.authPrincipal as IdentityPrincipal, routeId(request), requestMetadata(request));
      response.json({ user });
    })
  );

  admin.post(
    "/users/:id/disable",
    asyncRoute(async (request, response) => {
      const user = await service.disableUser(response.locals.authPrincipal as IdentityPrincipal, routeId(request), requestMetadata(request));
      response.json({ user });
    })
  );

  admin.patch(
    "/users/:id/permissions",
    asyncRoute(async (request, response) => {
      const parsed = permissionsSchema.safeParse(request.body);
      if (!parsed.success) return validationError(response, parsed.error.flatten());
      const user = await service.updatePermissions(response.locals.authPrincipal as IdentityPrincipal, routeId(request), parsed.data, requestMetadata(request));
      response.json({ user });
    })
  );

  for (const router of [auth, admin]) router.use(identityErrorHandler);
  return { auth, admin };
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

async function requirePrincipal(service: IdentityService, request: Request): Promise<IdentityPrincipal> {
  const principal = await principalFromRequest(service, request);
  if (!principal) throw new IdentityError(401, "not_authenticated", "Authentication is required.");
  return principal;
}

function requireCsrf(service: IdentityService, principal: IdentityPrincipal, request: Request): void {
  if (!service.verifyCsrf(principal, csrfFromRequest(request))) {
    throw new IdentityError(403, "invalid_csrf", "Missing or invalid CSRF token.");
  }
}

function tradingAvailable(service: IdentityService, user: IdentityPrincipal["user"]): boolean {
  return user.appRole === "admin" || (service.allowNonAdminTrading && user.tradingRole !== "none");
}

function rateLimited(retryAfter: number | undefined, response: Response): boolean {
  if (!retryAfter) return false;
  response.setHeader("Retry-After", String(retryAfter));
  response.status(429).json({ error: "Too many attempts. Try again later.", code: "rate_limited" });
  return true;
}

function validationError(response: Response, details: unknown): void {
  response.status(400).json({ error: "Invalid request.", code: "invalid_request", details });
}

function parseStatus(value: unknown): UserStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "pending" || value === "active" || value === "disabled") return value;
  throw new IdentityError(400, "invalid_status", "Invalid user status filter.");
}

function routeId(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function identityErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof PasswordHashCapacityError) {
    response.setHeader("Retry-After", "1");
    response.status(503).json({ error: "Authentication is temporarily unavailable. Try again later.", code: "auth_busy" });
    return;
  }
  if (!(error instanceof IdentityError)) {
    next(error);
    return;
  }
  response.status(error.status).json({ error: error.message, code: error.code });
}

function requestIpKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function loginIdentityKey(login: string): string {
  return createHash("sha256").update(normalizeLogin(login)).digest("base64url");
}

function isCredentialFailure(error: unknown): boolean {
  return error instanceof IdentityError && error.code === "invalid_credentials";
}

function isProvenCredentialRejection(error: unknown): boolean {
  return error instanceof IdentityError && (error.code === "pending_approval" || error.code === "account_disabled");
}

function authRateLimitConfiguration(): {
  maxEntries: number;
  loginIp: AuthRateLimitPolicy;
  loginIdentity: AuthRateLimitPolicy;
  registrationIp: AuthRateLimitPolicy;
} {
  const loginWindowMs = boundedEnv("AUTH_LOGIN_RATE_WINDOW_MS", 15 * 60_000, 60_000, 24 * 60 * 60_000);
  const loginBlockMs = boundedEnv("AUTH_LOGIN_RATE_BLOCK_MS", 15 * 60_000, 60_000, 24 * 60 * 60_000);
  return {
    maxEntries: boundedEnv("AUTH_RATE_LIMIT_MAX_ENTRIES", 4_096, 256, 100_000),
    loginIp: {
      windowMs: loginWindowMs,
      maxAttempts: boundedEnv("AUTH_LOGIN_IP_MAX_FAILURES", 30, 3, 10_000),
      blockMs: loginBlockMs
    },
    loginIdentity: {
      windowMs: loginWindowMs,
      maxAttempts: boundedEnv("AUTH_LOGIN_IDENTITY_MAX_FAILURES", 10, 3, 1_000),
      blockMs: loginBlockMs
    },
    registrationIp: {
      windowMs: boundedEnv("AUTH_REGISTER_RATE_WINDOW_MS", 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
      maxAttempts: boundedEnv("AUTH_REGISTER_IP_MAX_ATTEMPTS", 5, 1, 1_000),
      blockMs: boundedEnv("AUTH_REGISTER_RATE_BLOCK_MS", 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000)
    }
  };
}

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback;
}
