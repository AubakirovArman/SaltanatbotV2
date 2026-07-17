import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { ALERT_EVENT_PAGE_SCHEMA_V1, ALERT_RULE_LIST_SCHEMA_V1, ALERT_RULE_RECORD_SCHEMA_V1, parseAlertEventPageV1, parseAlertEventV1, parseAlertRuleListV1, parseAlertRuleRecordV1, parseNotificationOutboxItemV1, type AlertEventPageV1, type AlertEventV1, type AlertRuleListV1, type AlertRuleRecordV1, type NotificationOutboxItemV1 } from "@saltanatbotv2/contracts";
import type { IdentityPrincipal } from "../identity/types.js";
import { parseAlertPageLimit, parseAlertRuleRevisionRequest, parseCreateAlertRuleRequest, parseUpdateAlertRuleRequest } from "./apiSchema.js";
import { AlertEventCursorError, decodeAlertEventCursor, encodeAlertEventCursor } from "./eventCursor.js";
import { AlertEventCursorAheadError, listAlertEventPage, parseAlertEventNotBefore, type AlertEventPageResult, type ListAlertEventPageInput } from "./eventPages.js";
import { AlertRepository } from "./repository.js";
import {
  ALERT_REPOSITORY_MAX_LIST_LIMIT,
  AlertCapacityError,
  AlertEvaluationConflictError,
  AlertIdempotencyConflictError,
  AlertNotFoundError,
  AlertQuotaError,
  AlertRevisionConflictError,
  type AlertRuleRecord,
  type ArchiveAlertRuleInput,
  type CreateAlertRuleInput,
  type RearmAlertRuleInput,
  type UpdateAlertRuleInput
} from "./repositoryTypes.js";

export const ALERT_REQUEST_BODY_BYTE_LIMIT = 65_536;

export interface AlertRepositoryContract {
  create(input: CreateAlertRuleInput): Promise<AlertRuleRecord>;
  list(ownerUserId: string, limit?: number): Promise<AlertRuleRecord[]>;
  get(ownerUserId: string, ruleId: string): Promise<AlertRuleRecord | undefined>;
  update(input: UpdateAlertRuleInput): Promise<AlertRuleRecord>;
  archive(input: ArchiveAlertRuleInput): Promise<AlertRuleRecord>;
  rearm(input: RearmAlertRuleInput): Promise<AlertRuleRecord>;
  listEvents(ownerUserId: string, ruleId?: string, limit?: number): Promise<AlertEventV1[]>;
  listOutbox(ownerUserId: string, limit?: number): Promise<NotificationOutboxItemV1[]>;
}

export interface AlertRouterOptions {
  repository?: AlertRepositoryContract;
  eventPageReader?: {
    list(input: ListAlertEventPageInput): Promise<AlertEventPageResult>;
  };
  now?: () => number;
}

export function createAlertRouter(pool: Pool, options: AlertRouterOptions = {}): Router {
  const repository = options.repository ?? new AlertRepository(pool);
  const eventPageReader = options.eventPageReader ?? {
    list: (input: ListAlertEventPageInput) => listAlertEventPage(pool, input)
  };
  const now = options.now ?? Date.now;
  const router = Router();

  router.use((_request, response, next) => {
    noStore(response);
    next();
  });
  router.use(requireExpectedOwner);
  router.use(
    express.json({
      limit: ALERT_REQUEST_BODY_BYTE_LIMIT,
      strict: true
    })
  );

  router.get(
    "/",
    asyncRoute(async (request, response) => {
      const query = parseListQuery(request);
      const rules = await repository.list(owner(response), query.limit);
      response.json(publicRuleList(rules, now()));
    })
  );

  router.post(
    "/",
    asyncRoute(async (request, response) => {
      const input = parseRequest(() => parseCreateAlertRuleRequest(request.body));
      assertSupportedDefinition(input.definition);
      const ownerUserId = owner(response);
      const rule = await repository.create({
        ownerUserId,
        actorUserId: ownerUserId,
        authorizationRevision: authorizationRevision(response),
        clientId: input.clientId,
        definition: input.definition
      });
      response.status(201).json({ rule: publicRule(rule) });
    })
  );

  router.get(
    "/events",
    asyncRoute(async (request, response) => {
      const query = parseEventsQuery(request);
      const ownerUserId = owner(response);
      const cursor = query.cursor ? decodeAlertEventCursor(ownerUserId, query.cursor) : undefined;
      const page = await eventPageReader.list({
        ownerUserId,
        ...(query.ruleId ? { ruleId: query.ruleId } : {}),
        ...(cursor ? { afterOwnerSequence: cursor.ownerSequence } : {}),
        ...(query.since ? { notBefore: query.since } : {}),
        limit: query.limit
      });
      response.json(publicEventPage(ownerUserId, page));
    })
  );

  router.get(
    "/outbox",
    asyncRoute(async (request, response) => {
      const query = parseListQuery(request);
      const items = await repository.listOutbox(owner(response), query.limit);
      response.json({
        items: items.map(parseNotificationOutboxItemV1),
        researchOnly: true,
        executionPermission: false
      });
    })
  );

  router.get(
    "/:id",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const rule = await repository.get(owner(response), routeRuleId(request));
      if (!rule) throw new AlertNotFoundError("Alert rule was not found for this owner.");
      response.json({ rule: publicRule(rule) });
    })
  );

  router.put(
    "/:id",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseUpdateAlertRuleRequest(request.body));
      assertSupportedDefinition(input.definition);
      const ownerUserId = owner(response);
      const rule = await repository.update({
        ownerUserId,
        actorUserId: ownerUserId,
        ruleId: routeRuleId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response),
        definition: input.definition
      });
      response.json({ rule: publicRule(rule) });
    })
  );

  router.post(
    "/:id/archive",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseAlertRuleRevisionRequest(request.body));
      const ownerUserId = owner(response);
      const rule = await repository.archive({
        ownerUserId,
        actorUserId: ownerUserId,
        ruleId: routeRuleId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response)
      });
      response.json({ rule: publicRule(rule) });
    })
  );

  router.delete(
    "/:id",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseAlertRuleRevisionRequest(request.body));
      const ownerUserId = owner(response);
      const rule = await repository.archive({
        ownerUserId,
        actorUserId: ownerUserId,
        ruleId: routeRuleId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response)
      });
      response.json({ rule: publicRule(rule) });
    })
  );

  router.post(
    "/:id/rearm",
    asyncRoute(async (request, response) => {
      assertNoQuery(request);
      const input = parseRequest(() => parseAlertRuleRevisionRequest(request.body));
      const ownerUserId = owner(response);
      const rule = await repository.rearm({
        ownerUserId,
        actorUserId: ownerUserId,
        ruleId: routeRuleId(request),
        expectedRevision: input.expectedRevision,
        authorizationRevision: authorizationRevision(response)
      });
      response.json({ rule: publicRule(rule) });
    })
  );

  router.use(alertErrorHandler);
  return router;
}

export function publicRule(rule: AlertRuleRecord): AlertRuleRecordV1 {
  return parseAlertRuleRecordV1({
    schemaVersion: ALERT_RULE_RECORD_SCHEMA_V1,
    id: rule.id,
    clientId: rule.clientId,
    revision: rule.currentRevision,
    definition: rule.definition,
    lifecycleState: lifecycleState(rule),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    ...(rule.lastEvaluatedAt ? { lastEvaluatedAt: rule.lastEvaluatedAt } : {}),
    ...(rule.lastErrorCode ? { lastErrorCode: rule.lastErrorCode } : {}),
    researchOnly: true,
    executionPermission: false
  });
}

function publicRuleList(rules: AlertRuleRecord[], generatedAt: number): AlertRuleListV1 {
  return parseAlertRuleListV1({
    schemaVersion: ALERT_RULE_LIST_SCHEMA_V1,
    rules: rules.map(publicRule),
    generatedAt: new Date(generatedAt).toISOString(),
    researchOnly: true,
    executionPermission: false
  });
}

function publicEventPage(ownerUserId: string, page: AlertEventPageResult): AlertEventPageV1 {
  return parseAlertEventPageV1({
    schemaVersion: ALERT_EVENT_PAGE_SCHEMA_V1,
    events: page.events.map(parseAlertEventV1),
    nextCursor: encodeAlertEventCursor(ownerUserId, page.nextOwnerSequence),
    hasMore: page.hasMore,
    generatedAt: page.generatedAt,
    researchOnly: true,
    executionPermission: false
  });
}

function lifecycleState(rule: AlertRuleRecord): AlertRuleRecordV1["lifecycleState"] {
  if (rule.status === "archived") return "archived";
  if (rule.status === "disabled") {
    return rule.definition.enabled ? "triggered" : "disabled";
  }
  if (isStaleEvaluationCode(rule.lastErrorCode)) return "stale";
  if (rule.lastErrorCode) return "error";
  return "armed";
}

function isStaleEvaluationCode(code: string | undefined): boolean {
  return code === "stale-candle-window" || code === "stale_candle_window" || code === "public_stale_candle_window" || code === "unavailable_stale_candle_window";
}

function parseListQuery(request: Request): { limit: number } {
  const query = exactQuery(request, ["limit"]);
  return {
    limit: parseRequest(() => parseAlertPageLimit(query.limit, ALERT_REPOSITORY_MAX_LIST_LIMIT, ALERT_REPOSITORY_MAX_LIST_LIMIT))
  };
}

function parseEventsQuery(request: Request): {
  ruleId?: string;
  cursor?: string;
  since?: string;
  limit: number;
} {
  const query = exactQuery(request, ["ruleId", "cursor", "since", "limit"]);
  return {
    ...(query.ruleId === undefined ? {} : { ruleId: parseRequest(() => uuid(query.ruleId, "ruleId")) }),
    ...(query.cursor === undefined ? {} : { cursor: parseRequest(() => opaqueCursor(query.cursor)) }),
    ...(query.since === undefined ? {} : { since: parseRequest(() => parseAlertEventNotBefore(query.since)) }),
    limit: parseRequest(() => parseAlertPageLimit(query.limit, ALERT_REPOSITORY_MAX_LIST_LIMIT, ALERT_REPOSITORY_MAX_LIST_LIMIT))
  };
}

function exactQuery(request: Request, allowed: readonly string[]): Record<string, unknown> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some((key) => !allowed.includes(key))) {
    throw new AlertApiRequestError("Alert query has unknown fields.");
  }
  return query;
}

function assertNoQuery(request: Request): void {
  exactQuery(request, []);
}

function routeRuleId(request: Request): string {
  const value = request.params.id;
  return parseRequest(() => uuid(Array.isArray(value) ? value[0] : value, "rule id"));
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function opaqueCursor(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error("alert event cursor is invalid");
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
    throw new AlertAuthorizationChangedError();
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
    error: "The authenticated alert owner changed. Reload before synchronizing alerts.",
    code: "alert_owner_mismatch"
  });
}

function alertErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof AlertNotFoundError) {
    response.status(404).json({ error: error.message, code: "alert_not_found" });
    return;
  }
  if (error instanceof AlertQuotaError) {
    response.status(429).json({ error: error.message, code: "alert_quota_exceeded" });
    return;
  }
  if (error instanceof AlertCapacityError) {
    response.status(429).json({
      error: "The R5.1 alert evaluator is at its global beta capacity.",
      code: "alert_capacity_exceeded"
    });
    return;
  }
  if (error instanceof AlertEventCursorError) {
    response.status(400).json({
      error: "Alert event cursor is invalid for this owner.",
      code: "invalid_alert_event_cursor"
    });
    return;
  }
  if (error instanceof AlertEventCursorAheadError) {
    response.status(409).json({
      error: "Alert event history changed after recovery. Reload its history before continuing.",
      code: "alert_event_cursor_ahead"
    });
    return;
  }
  if (error instanceof AlertIdempotencyConflictError) {
    response.status(409).json({ error: error.message, code: "alert_idempotency_conflict" });
    return;
  }
  if (error instanceof AlertRevisionConflictError) {
    response.status(409).json({ error: error.message, code: "alert_revision_conflict" });
    return;
  }
  if (error instanceof AlertEvaluationConflictError) {
    response.status(409).json({
      error: "Alert authorization changed. Reload before synchronizing alerts.",
      code: "alert_authorization_changed"
    });
    return;
  }
  if (error instanceof AlertAuthorizationChangedError) {
    response.status(409).json({
      error: "Alert authorization changed. Reload before synchronizing alerts.",
      code: "alert_authorization_changed"
    });
    return;
  }
  if (isBodyTooLarge(error)) {
    response.status(413).json({
      error: `Alert request body exceeds ${ALERT_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "alert_envelope_too_large"
    });
    return;
  }
  if (isInvalidJson(error)) {
    response.status(400).json({
      error: "Alert request body is not valid JSON.",
      code: "invalid_json"
    });
    return;
  }
  if (error instanceof AlertApiRequestError) {
    response.status(400).json({
      error: "Invalid alert request.",
      code: "invalid_request"
    });
    return;
  }
  if (error instanceof UnsupportedAlertKindError) {
    response.status(400).json({
      error: "Only price-threshold alerts are available in R5.1.",
      code: "unsupported_alert_kind"
    });
    return;
  }
  if (error instanceof UnsupportedAlertDeliveryChannelError) {
    response.status(400).json({
      error: "Only in-app alert delivery is available in R5.1.",
      code: "unsupported_alert_delivery_channel"
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
    throw new AlertApiRequestError("Invalid alert API input.", { cause: error });
  }
}

function assertSupportedDefinition(input: {
  kind: string;
  deliveryChannels?: readonly string[];
}): void {
  if (input.kind !== "price-threshold") throw new UnsupportedAlertKindError();
  if (input.deliveryChannels?.length !== 1 || input.deliveryChannels[0] !== "in-app") {
    throw new UnsupportedAlertDeliveryChannelError();
  }
}

function noStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
}

function isBodyTooLarge(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.too.large";
}

function isInvalidJson(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed";
}

class AlertApiRequestError extends Error {}

class AlertAuthorizationChangedError extends Error {}

class UnsupportedAlertKindError extends Error {}

class UnsupportedAlertDeliveryChannelError extends Error {}
