import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import type { IdentityPrincipal } from "../identity/types.js";
import {
  BINDING_CODE_MAX_OUTSTANDING,
  BindingCodeQuotaError,
  BindingNotFoundError,
  BindingRevisionConflictError,
  createBindingCode,
  listBindings,
  revokeBinding,
  type CreatedBindingCode,
  type NotificationBindingPublic,
  type RevokeBindingResult
} from "../notifications/bindingService.js";
import { createBindingCodeRateLimiter } from "../notifications/rateLimits.js";

export const BINDING_REQUEST_BODY_BYTE_LIMIT = 4_096;

/**
 * Owner-scoped Telegram binding endpoints, mounted at /api/alerts/bindings
 * under the same auth stack (and owner-pinning header) as the alert routes.
 *
 * POST /codes returns the raw one-consume code exactly once — it is never
 * stored, logged or listable afterwards. GET / lists bindings with hashed
 * recipient handles only. POST /:id/revoke fences on expectedRevision and
 * cancels the binding's queued/retrying deliveries in the same transaction.
 */

export interface BindingRepositoryContract {
  createCode(ownerUserId: string): Promise<CreatedBindingCode>;
  list(ownerUserId: string): Promise<NotificationBindingPublic[]>;
  revoke(input: { ownerUserId: string; bindingId: string; expectedRevision: number }): Promise<RevokeBindingResult>;
}

export interface BindingRouterOptions {
  repository?: BindingRepositoryContract;
  codeRateLimiter?: ReturnType<typeof createBindingCodeRateLimiter>;
  now?: () => number;
}

export function createAlertBindingRouter(pool: Pool, options: BindingRouterOptions = {}): Router {
  const repository = options.repository ?? {
    createCode: (ownerUserId: string) => createBindingCode(pool, ownerUserId),
    list: (ownerUserId: string) => listBindings(pool, ownerUserId),
    revoke: (input: { ownerUserId: string; bindingId: string; expectedRevision: number }) => revokeBinding(pool, input)
  };
  const codeRateLimiter = options.codeRateLimiter ?? createBindingCodeRateLimiter();
  const now = options.now ?? Date.now;
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(requireExpectedOwner);
  router.use(express.json({ limit: BINDING_REQUEST_BODY_BYTE_LIMIT, strict: true }));

  router.get(
    "/",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const bindings = await repository.list(owner(response));
      response.json({ bindings, researchOnly: true, executionPermission: false });
    })
  );

  router.post(
    "/codes",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      assertEmptyBody(request);
      const ownerUserId = owner(response);
      const retryAfter = codeRateLimiter.attempt(ownerUserId, now());
      if (retryAfter !== undefined) {
        response.setHeader("Retry-After", String(retryAfter));
        response.status(429).json({
          error: "Binding code requests are limited. Try again shortly.",
          code: "binding_code_rate_limited",
          retryable: true
        });
        return;
      }
      const created = await repository.createCode(ownerUserId);
      // The raw code appears in this response body exactly once and nowhere else.
      response.status(201).json({
        code: created.code,
        codeId: created.id,
        expiresAt: created.expiresAt,
        researchOnly: true,
        executionPermission: false
      });
    })
  );

  router.post(
    "/:id/revoke",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const result = await repository.revoke({
        ownerUserId: owner(response),
        bindingId: routeBindingId(request),
        expectedRevision: expectedRevision(request.body)
      });
      response.json({ binding: result.binding, cancelledDeliveries: result.cancelledDeliveries });
    })
  );

  router.use(bindingErrorHandler);
  return router;
}

function bindingErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof BindingNotFoundError) {
    response.status(404).json({ error: error.message, code: "binding_not_found" });
    return;
  }
  if (error instanceof BindingRevisionConflictError) {
    response.status(409).json({ error: error.message, code: "binding_revision_conflict" });
    return;
  }
  if (error instanceof BindingCodeQuotaError) {
    response.status(429).json({
      error: `At most ${BINDING_CODE_MAX_OUTSTANDING} unconsumed binding codes may be outstanding.`,
      code: "binding_code_quota_exceeded"
    });
    return;
  }
  if (isBodyTooLarge(error)) {
    response.status(413).json({
      error: `Binding request body exceeds ${BINDING_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "binding_request_too_large"
    });
    return;
  }
  if (isInvalidJson(error)) {
    response.status(400).json({ error: "Binding request body is not valid JSON.", code: "invalid_json" });
    return;
  }
  if (error instanceof BindingApiRequestError) {
    response.status(400).json({ error: "Invalid binding request.", code: "invalid_request" });
    return;
  }
  next(error);
}

function routeBindingId(request: Request): string {
  const value = request.params.id;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new BindingApiRequestError("binding id is invalid");
  }
  return candidate;
}

function expectedRevision(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BindingApiRequestError("binding revoke body is invalid");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "expectedRevision") throw new BindingApiRequestError("binding revoke body is invalid");
  const revision = (body as { expectedRevision?: unknown }).expectedRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new BindingApiRequestError("expectedRevision is invalid");
  return Number(revision);
}

function assertEmptyBody(request: Request): void {
  const body = request.body as unknown;
  if (body === undefined || body === null) return;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body as Record<string, unknown>).length === 0) return;
  throw new BindingApiRequestError("binding code request takes no body fields");
}

function assertNoQuery(request: Request): void {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw new BindingApiRequestError("binding query has unknown fields");
  }
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function requireExpectedOwner(request: Request, response: Response, next: NextFunction): void {
  if (response.locals.authMode !== "database") {
    next();
    return;
  }
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (principal && request.header("X-SBV2-Expected-User") === principal.user.id) {
    next();
    return;
  }
  response.status(409).json({
    error: "The authenticated alert owner changed. Reload before managing bindings.",
    code: "alert_owner_mismatch"
  });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function isBodyTooLarge(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.too.large";
}

function isInvalidJson(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed";
}

class BindingApiRequestError extends Error {}
