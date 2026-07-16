import express, { Router } from "express";
import { AuthRateLimiter, BoundedAuthRateLimitStore, type AuthRateLimitPolicy } from "./rateLimit.js";
import { clearAuthCookies, csrfFromCookie, principalFromRequest, requestMetadata, setAuthCookies } from "./http.js";
import {
  changePasswordSchema,
  lifecycleSchema,
  loginSchema,
  mutationBaseSchema,
  permissionsSchema,
  reasonSchema,
  registerSchema,
  uuidSchema
} from "./routeSchemas.js";
import {
  adminMutationResponse,
  asyncRoute,
  authRateLimitConfiguration,
  identityErrorHandler,
  identityRequestContext,
  isCredentialFailure,
  isProvenCredentialRejection,
  loginIdentityKey,
  optionalQuery,
  optionalUuidQuery,
  pageRequest,
  pagedResponse,
  parseAppRole,
  parseStatus,
  parseTradingRole,
  rateLimited,
  requestIpKey,
  requireCsrf,
  requirePrincipal,
  routeId,
  routeParam,
  tradingAvailable,
  validationError
} from "./routeSupport.js";
import { IdentityError, IdentityService } from "./service.js";
import type { IdentityPrincipal } from "./types.js";

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
  auth.use(identityRequestContext);
  admin.use(identityRequestContext);
  admin.param("id", (_request, _response, next, value) => {
    if (!uuidSchema.safeParse(value).success) {
      next(new IdentityError(400, "invalid_user_id", "Invalid user identifier."));
      return;
    }
    next();
  });
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
      const user = await service.register(parsed.data.login, parsed.data.password, requestMetadata(request, response));
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
        const credentials = await service.login(parsed.data.login, parsed.data.password, requestMetadata(request, response));
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
      await service.logout(principal, requestMetadata(request, response));
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
      await service.changePassword(principal, parsed.data.currentPassword, parsed.data.newPassword, requestMetadata(request, response));
      clearAuthCookies(response);
      response.json({ ok: true, reloginRequired: true });
    })
  );

  auth.get(
    "/sessions",
    asyncRoute(async (request, response) => {
      const principal = await requirePrincipal(service, request);
      const result = await service.listOwnSessions(
        principal,
        pageRequest(request)
      );
      response.setHeader("Cache-Control", "no-store");
      response.json(pagedResponse("sessions", result.items, result));
    })
  );

  const revokeOwnSession = asyncRoute(async (request, response) => {
    const principal = await requirePrincipal(service, request);
    requireCsrf(service, principal, request);
    const parsed = reasonSchema.safeParse(request.body);
    const publicId = uuidSchema.safeParse(routeParam(request, "publicId"));
    if (!parsed.success || !publicId.success) {
      return validationError(response, {
        body: parsed.success ? undefined : parsed.error.flatten(),
        publicId: publicId.success ? undefined : publicId.error.flatten()
      });
    }
    const result = await service.revokeOwnSession(
      principal,
      publicId.data,
      parsed.data.reason,
      requestMetadata(request, response)
    );
    if (result.revokedCurrentSession) clearAuthCookies(response);
    response.json(result);
  });

  auth.post("/sessions/:publicId/revoke", revokeOwnSession);
  auth.delete("/sessions/:publicId", revokeOwnSession);

  auth.post(
    "/sessions/revoke-others",
    asyncRoute(async (request, response) => {
      const principal = await requirePrincipal(service, request);
      requireCsrf(service, principal, request);
      const parsed = reasonSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.revokeOtherSessions(
        principal,
        parsed.data.reason,
        requestMetadata(request, response)
      );
      response.json(result);
    })
  );

  auth.post(
    "/sessions/revoke-all",
    asyncRoute(async (request, response) => {
      const principal = await requirePrincipal(service, request);
      requireCsrf(service, principal, request);
      const parsed = reasonSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.revokeAllOwnSessions(
        principal,
        parsed.data.reason,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(result);
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
      const result = await service.listUsersPage(
        response.locals.authPrincipal as IdentityPrincipal,
        {
          ...pageRequest(request),
          status,
          appRole: parseAppRole(request.query.appRole),
          tradingRole: parseTradingRole(request.query.tradingRole),
          query: optionalQuery(request.query.query, 64)
        }
      );
      response.json(pagedResponse("users", result.items, result));
    })
  );

  admin.post(
    "/users/:id/activate",
    asyncRoute(async (request, response) => {
      const parsed = lifecycleSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.activateUser(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        parsed.data,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(adminMutationResponse(result));
    })
  );

  admin.post(
    "/users/:id/reactivate",
    asyncRoute(async (request, response) => {
      const parsed = lifecycleSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.reactivateUser(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        parsed.data,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(adminMutationResponse(result));
    })
  );

  admin.post(
    "/users/:id/disable",
    asyncRoute(async (request, response) => {
      const parsed = mutationBaseSchema.strict().safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.disableUser(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        parsed.data,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(adminMutationResponse(result));
    })
  );

  admin.patch(
    "/users/:id/permissions",
    asyncRoute(async (request, response) => {
      const parsed = permissionsSchema.safeParse(request.body);
      if (!parsed.success) return validationError(response, parsed.error.flatten());
      const result = await service.updatePermissions(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        parsed.data,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(adminMutationResponse(result));
    })
  );

  admin.get(
    "/users/:id/sessions",
    asyncRoute(async (request, response) => {
      const result = await service.listAdminSessions(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        pageRequest(request)
      );
      response.json(pagedResponse("sessions", result.items, result));
    })
  );

  admin.post(
    "/users/:id/sessions/:publicId/revoke",
    asyncRoute(async (request, response) => {
      const parsed = reasonSchema.safeParse(request.body);
      const publicId = uuidSchema.safeParse(routeParam(request, "publicId"));
      if (!parsed.success || !publicId.success) {
        return validationError(response, {
          body: parsed.success ? undefined : parsed.error.flatten(),
          publicId: publicId.success ? undefined : publicId.error.flatten()
        });
      }
      const result = await service.revokeAdminSession(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        publicId.data,
        parsed.data.reason,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(result);
    })
  );

  admin.post(
    "/users/:id/sessions/revoke-all",
    asyncRoute(async (request, response) => {
      const parsed = reasonSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(response, parsed.error.flatten());
      }
      const result = await service.revokeAllUserSessionsAdmin(
        response.locals.authPrincipal as IdentityPrincipal,
        routeId(request),
        parsed.data.reason,
        requestMetadata(request, response)
      );
      if (result.revokedCurrentSession) clearAuthCookies(response);
      response.json(result);
    })
  );

  admin.get(
    "/audit",
    asyncRoute(async (request, response) => {
      const result = await service.listAuditEvents(
        response.locals.authPrincipal as IdentityPrincipal,
        {
          ...pageRequest(request),
          subjectUserId: optionalUuidQuery(request.query.subjectUserId),
          eventType: optionalQuery(request.query.eventType, 96)
        }
      );
      response.json(pagedResponse("events", result.items, result));
    })
  );

  for (const router of [auth, admin]) router.use(identityErrorHandler);
  return { auth, admin };
}
