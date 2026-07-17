import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { parseScreenerPresetListV1, parseScreenerPresetV1, SCREENER_PRESET_LIST_SCHEMA_V1, type ScreenerPresetListV1, type ScreenerPresetV1 } from "@saltanatbotv2/contracts";
import type { IdentityPrincipal } from "../identity/types.js";
import { parseCreateScreenerPresetRequest, parseScreenerPageLimit, parseScreenerPresetRevisionRequest, parseUpdateScreenerPresetRequest, SCREENER_REQUEST_BODY_BYTE_LIMIT } from "./apiSchema.js";
import { ScreenerRepository } from "./repository.js";
import {
  SCREENER_REPOSITORY_MAX_LIST_LIMIT,
  ScreenerAuthorizationConflictError,
  ScreenerCapacityError,
  ScreenerIdempotencyConflictError,
  ScreenerNotFoundError,
  ScreenerQuotaError,
  ScreenerRevisionConflictError,
  type ScreenerPresetRecord,
  type ScreenerRepositoryContract
} from "./repositoryTypes.js";

export { SCREENER_REQUEST_BODY_BYTE_LIMIT } from "./apiSchema.js";

/**
 * Owner-scoped screener preset management. Screener RUNS are not served here:
 * they are enqueued through the existing POST /api/jobs endpoint with kind
 * "screener" and polled like any other research job (see docs/SCREENER.md).
 */

export interface ScreenerRouterOptions {
  repository?: ScreenerRepositoryContract;
  now?: () => number;
}

export function createScreenerRouter(pool: Pool, options: ScreenerRouterOptions = {}): Router {
  const repository = options.repository ?? new ScreenerRepository(pool);
  const now = options.now ?? Date.now;
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(requireExpectedOwner);
  router.use(
    express.json({
      limit: SCREENER_REQUEST_BODY_BYTE_LIMIT,
      strict: true
    })
  );

  router.get(
    "/presets",
    asyncRoute(async (request, response) => {
      const query = parseListQuery(request);
      const presets = await repository.list(owner(response), query.limit);
      response.json(publicPresetList(presets, now()));
    })
  );

  router.post(
    "/presets",
    asyncRoute(async (request, response) => {
      const input = parseRequest(() => parseCreateScreenerPresetRequest(request.body));
      const ownerUserId = owner(response);
      const preset = await repository.create({
        ownerUserId,
        actorUserId: ownerUserId,
        authorizationRevision: authorizationRevision(response),
        clientId: input.clientId,
        definition: input.definition
      });
      response.status(201).json({ preset: publicPreset(preset) });
    })
  );

  router.put(
    "/presets/:id",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseUpdateScreenerPresetRequest(request.body));
      const ownerUserId = owner(response);
      const preset = await repository.update({
        ownerUserId,
        actorUserId: ownerUserId,
        presetId: routePresetId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response),
        definition: input.definition
      });
      response.json({ preset: publicPreset(preset) });
    })
  );

  router.post(
    "/presets/:id/archive",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseScreenerPresetRevisionRequest(request.body));
      const ownerUserId = owner(response);
      const preset = await repository.archive({
        ownerUserId,
        actorUserId: ownerUserId,
        presetId: routePresetId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response)
      });
      response.json({ preset: publicPreset(preset) });
    })
  );

  router.use(screenerErrorHandler);
  return router;
}

/** Public projection: owner, authorization and hash internals never leave the server. */
export function publicPreset(preset: ScreenerPresetRecord): ScreenerPresetV1 {
  return parseScreenerPresetV1({
    id: preset.id,
    clientId: preset.clientId,
    revision: preset.revision,
    definition: preset.definition,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    ...(preset.archivedAt ? { archivedAt: preset.archivedAt } : {}),
    researchOnly: true,
    executionPermission: false
  });
}

function publicPresetList(presets: ScreenerPresetRecord[], generatedAt: number): ScreenerPresetListV1 {
  return parseScreenerPresetListV1({
    schemaVersion: SCREENER_PRESET_LIST_SCHEMA_V1,
    presets: presets.map(publicPreset),
    generatedAt: new Date(generatedAt).toISOString(),
    researchOnly: true,
    executionPermission: false
  });
}

function parseListQuery(request: Request): { limit: number } {
  const query = exactQuery(request, ["limit"]);
  return {
    limit: parseRequest(() => parseScreenerPageLimit(query.limit, SCREENER_REPOSITORY_MAX_LIST_LIMIT, SCREENER_REPOSITORY_MAX_LIST_LIMIT))
  };
}

function exactQuery(request: Request, allowed: readonly string[]): Record<string, unknown> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some((key) => !allowed.includes(key))) {
    throw new ScreenerApiRequestError("Screener query has unknown fields.");
  }
  return query;
}

function assertNoQuery(request: Request): void {
  exactQuery(request, []);
}

function routePresetId(request: Request): string {
  const value = request.params.id;
  return parseRequest(() => uuid(Array.isArray(value) ? value[0] : value, "preset id"));
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function authorizationRevision(response: Response): number {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  const revision = principal?.user.authorizationRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new ScreenerAuthorizationChangedError();
  }
  return Number(revision);
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
    error: "The authenticated screener owner changed. Reload before synchronizing screener presets.",
    code: "screener_owner_mismatch"
  });
}

function screenerErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof ScreenerNotFoundError) {
    response.status(404).json({ error: error.message, code: "screener_preset_not_found" });
    return;
  }
  if (error instanceof ScreenerQuotaError) {
    response.status(429).json({ error: error.message, code: "screener_quota_exceeded" });
    return;
  }
  if (error instanceof ScreenerCapacityError) {
    response.status(429).json({
      error: "The R5.2 screener is at its global beta preset capacity.",
      code: "screener_capacity_exceeded"
    });
    return;
  }
  if (error instanceof ScreenerIdempotencyConflictError) {
    response.status(409).json({ error: error.message, code: "screener_idempotency_conflict" });
    return;
  }
  if (error instanceof ScreenerRevisionConflictError) {
    response.status(409).json({ error: error.message, code: "screener_revision_conflict" });
    return;
  }
  if (error instanceof ScreenerAuthorizationConflictError || error instanceof ScreenerAuthorizationChangedError) {
    response.status(409).json({
      error: "Screener authorization changed. Reload before synchronizing screener presets.",
      code: "screener_authorization_changed"
    });
    return;
  }
  if (isBodyTooLarge(error)) {
    response.status(413).json({
      error: `Screener request body exceeds ${SCREENER_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "screener_envelope_too_large"
    });
    return;
  }
  if (isInvalidJson(error)) {
    response.status(400).json({
      error: "Screener request body is not valid JSON.",
      code: "invalid_json"
    });
    return;
  }
  if (error instanceof ScreenerApiRequestError) {
    response.status(400).json({
      error: "Invalid screener request.",
      code: "invalid_request"
    });
    return;
  }
  next(error);
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function parseRequest<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    throw new ScreenerApiRequestError("Invalid screener API input.", { cause: error });
  }
}

function isBodyTooLarge(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.too.large";
}

function isInvalidJson(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed";
}

class ScreenerApiRequestError extends Error {}

class ScreenerAuthorizationChangedError extends Error {}
