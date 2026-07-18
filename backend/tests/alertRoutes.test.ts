import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEventV1, NotificationOutboxItemV1, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { ALERT_REQUEST_BODY_BYTE_LIMIT, createAlertRouter, publicRule, type AlertRepositoryContract } from "../src/alerts/routes.js";
import { AlertEventCursorAheadError, type AlertEventPageResult } from "../src/alerts/eventPages.js";
import { AlertCapacityError, AlertEvaluationConflictError, AlertIdempotencyConflictError, AlertNotFoundError, AlertQuotaError, AlertRevisionConflictError, type AlertRuleRecord } from "../src/alerts/repositoryTypes.js";

const OWNER_A = "00000000-0000-4000-8000-000000000031";
const OWNER_B = "00000000-0000-4000-8000-000000000032";
const RULE_ID = "00000000-0000-4000-8000-000000000041";
const NOW = Date.parse("2026-07-17T08:00:00.000Z");
const EVENT_SINCE = "2026-07-17T07:00:00.000Z";
const definition: PriceThresholdAlertDefinitionV1 = {
  schemaVersion: "alert-rule-v1",
  kind: "price-threshold",
  name: "BTC threshold",
  enabled: true,
  cooldownSeconds: 60,
  deliveryChannels: ["in-app"],
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "65000.25",
  crossing: "inclusive",
  repeat: "once-until-rearmed",
  researchOnly: true,
  executionPermission: false
};

let server: Server;
let baseUrl: string;
let repository: AlertRepositoryContract;
let create: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let archive: ReturnType<typeof vi.fn>;
let rearm: ReturnType<typeof vi.fn>;
let listEvents: ReturnType<typeof vi.fn>;
let listEventPage: ReturnType<typeof vi.fn>;
let listOutbox: ReturnType<typeof vi.fn>;

describe("owner-scoped alert HTTP API", () => {
  beforeAll(async () => {
    create = vi.fn();
    list = vi.fn();
    get = vi.fn();
    update = vi.fn();
    archive = vi.fn();
    rearm = vi.fn();
    listEvents = vi.fn();
    listEventPage = vi.fn();
    listOutbox = vi.fn();
    repository = {
      create,
      list,
      get,
      update,
      archive,
      rearm,
      listEvents,
      listOutbox
    };
    const app = express();
    app.use((request, response, next) => {
      response.locals.authMode = request.header("x-test-auth-mode") ?? "database";
      response.locals.authPrincipal = {
        user: {
          id: request.header("x-test-owner"),
          appRole: request.header("x-test-app-role") ?? "user",
          authorizationRevision: 7
        }
      };
      next();
    });
    app.use("/api/alerts", createAlertRouter({} as Pool, {
      repository,
      eventPageReader: { list: listEventPage },
      now: () => NOW
    }));
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ code: "internal_error" });
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/alerts`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
    get.mockResolvedValue(record());
    create.mockResolvedValue(record());
    update.mockResolvedValue(record({ currentRevision: 2 }));
    archive.mockResolvedValue(record({ status: "archived", archivedAt: "2026-07-17T08:01:00.000Z" }));
    rearm.mockResolvedValue(record({ currentRevision: 2 }));
    listEvents.mockResolvedValue([]);
    listEventPage.mockResolvedValue({
      events: [],
      nextOwnerSequence: "0",
      hasMore: false,
      generatedAt: new Date(NOW).toISOString()
    } satisfies AlertEventPageResult);
    listOutbox.mockResolvedValue([]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("requires the session-bound expected owner and gives admins no cross-owner bypass", async () => {
    const missing = await fetch(baseUrl, { headers: principalHeaders(OWNER_A) });
    expect(missing.status).toBe(409);

    const adminMismatch = await fetch(baseUrl, {
      headers: principalHeaders(OWNER_A, OWNER_B, { "x-test-app-role": "admin" })
    });
    expect(adminMismatch.status).toBe(409);
    expect(await adminMismatch.json()).toMatchObject({ code: "alert_owner_mismatch" });
    expect(adminMismatch.headers.get("Cache-Control")).toBe("no-store");
    expect(list).not.toHaveBeenCalled();

    const own = await fetch(baseUrl, {
      headers: principalHeaders(OWNER_A, OWNER_A, { "x-test-app-role": "admin" })
    });
    expect(own.status).toBe(200);
    expect(list).toHaveBeenCalledWith(OWNER_A, 200);
  });

  it("creates, reads, updates, archives and rearms only as the authenticated owner", async () => {
    const created = await jsonRequest("", "POST", {
      clientId: "browser.alert-01",
      definition
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      authorizationRevision: 7,
      clientId: "browser.alert-01",
      definition
    });

    expect((await fetch(`${baseUrl}/${RULE_ID}`, { headers: headers() })).status).toBe(200);
    expect(get).toHaveBeenCalledWith(OWNER_A, RULE_ID);

    const updated = await jsonRequest(`/${RULE_ID}`, "PUT", {
      expectedRevision: 1,
      definition: { ...definition, threshold: "66000" }
    });
    expect(updated.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        ruleId: RULE_ID,
        expectedRevision: 1,
        authorizationRevision: 7
      })
    );

    expect((await jsonRequest(`/${RULE_ID}/archive`, "POST", { expectedRevision: 2 })).status).toBe(200);
    expect((await jsonRequest(`/${RULE_ID}`, "DELETE", { expectedRevision: 2 })).status).toBe(200);
    expect(archive).toHaveBeenNthCalledWith(1, expect.objectContaining({ ownerUserId: OWNER_A, actorUserId: OWNER_A }));
    expect(archive).toHaveBeenNthCalledWith(2, expect.objectContaining({ ownerUserId: OWNER_A, actorUserId: OWNER_A }));

    expect((await jsonRequest(`/${RULE_ID}/rearm`, "POST", { expectedRevision: 2 })).status).toBe(200);
    expect(rearm).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        ruleId: RULE_ID
      })
    );
  });

  it("returns contract-validated public projections without persistence or authority internals", async () => {
    list.mockResolvedValue([record()]);
    const response = await fetch(`${baseUrl}?limit=1`, { headers: headers() });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: "alert-rule-list-v1",
      rules: [
        expect.objectContaining({
          schemaVersion: "alert-rule-record-v1",
          id: RULE_ID,
          clientId: "browser.alert-01",
          revision: 1,
          lifecycleState: "armed",
          researchOnly: true,
          executionPermission: false
        })
      ],
      generatedAt: "2026-07-17T08:00:00.000Z",
      researchOnly: true,
      executionPermission: false
    });
    const serialized = JSON.stringify(body);
    for (const privateName of ["ownerUserId", "authorizationRevision", "definitionHash", "nextEvaluationAt", "evaluationFailureCount", "lease", "destination", "secret"]) {
      expect(serialized).not.toContain(privateName);
    }
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves owner-scoped event and outbox history with bounded exact queries", async () => {
    const events = await fetch(`${baseUrl}/events?ruleId=${RULE_ID}&since=${EVENT_SINCE}&limit=10`, {
      headers: headers()
    });
    expect(events.status).toBe(200);
    expect(listEventPage).toHaveBeenCalledWith({
      ownerUserId: OWNER_A,
      ruleId: RULE_ID,
      notBefore: EVENT_SINCE,
      limit: 10
    });
    expect(await events.json()).toMatchObject({
      schemaVersion: "alert-event-page-v1",
      events: [],
      hasMore: false,
      generatedAt: new Date(NOW).toISOString(),
      researchOnly: true,
      executionPermission: false
    });
    expect((await (await fetch(`${baseUrl}/events?limit=1`, { headers: headers() })).json()).nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const outbox = await fetch(`${baseUrl}/outbox?limit=20`, { headers: headers() });
    expect(outbox.status).toBe(200);
    expect(listOutbox).toHaveBeenCalledWith(OWNER_A, 20);

    for (const path of [
      "?limit=201",
      "?ownerUserId=x",
      "/events?ruleId=bad",
      "/events?since=2026-07-17T07:00:00Z"
    ]) {
      const invalid = await fetch(`${baseUrl}${path}`, { headers: headers() });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "Invalid alert request.",
        code: "invalid_request"
      });
    }
  });

  it("binds opaque event cursors to the owner and maps restored-stream conflicts", async () => {
    const initial = await fetch(`${baseUrl}/events?limit=10`, {
      headers: headers()
    });
    const initialBody = await initial.json() as { nextCursor: string };
    expect(initial.status).toBe(200);

    listEventPage.mockResolvedValueOnce({
      events: [],
      nextOwnerSequence: "7",
      hasMore: false,
      generatedAt: new Date(NOW).toISOString()
    } satisfies AlertEventPageResult);
    const next = await fetch(`${baseUrl}/events?limit=10&cursor=${initialBody.nextCursor}&since=${EVENT_SINCE}`, {
      headers: headers()
    });
    expect(next.status).toBe(200);
    expect(listEventPage).toHaveBeenLastCalledWith({
      ownerUserId: OWNER_A,
      afterOwnerSequence: "0",
      notBefore: EVENT_SINCE,
      limit: 10
    });

    const crossOwner = await fetch(`${baseUrl}/events?limit=10&cursor=${initialBody.nextCursor}`, {
      headers: principalHeaders(OWNER_B, OWNER_B)
    });
    expect(crossOwner.status).toBe(400);
    expect(await crossOwner.json()).toMatchObject({
      code: "invalid_alert_event_cursor"
    });

    listEventPage.mockRejectedValueOnce(
      new AlertEventCursorAheadError("restored stream"),
    );
    const ahead = await fetch(`${baseUrl}/events?limit=10&cursor=${initialBody.nextCursor}`, {
      headers: headers()
    });
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({
      code: "alert_event_cursor_ahead"
    });
  });

  it("rejects malformed, non-object and oversized JSON before repository access", async () => {
    const malformed = await fetch(baseUrl, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: '{"clientId":'
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_json" });

    const nonObject = await fetch(baseUrl, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: "[]"
    });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toMatchObject({ code: "invalid_request" });

    const crossOwnerBody = await jsonRequest("", "POST", {
      clientId: "browser.alert-01",
      definition,
      ownerUserId: OWNER_B
    });
    expect(crossOwnerBody.status).toBe(400);

    const oversized = await fetch(baseUrl, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(ALERT_REQUEST_BODY_BYTE_LIMIT) })
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: `Alert request body exceeds ${ALERT_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "alert_envelope_too_large"
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed on reserved alert kinds until their evaluator lanes exist", async () => {
    const reservedDefinition = {
      schemaVersion: "alert-rule-v1",
      kind: "basis-spread",
      name: "Reserved basis alert",
      enabled: false,
      cooldownSeconds: 60,
      deliveryChannels: ["in-app"],
      minimumNetEdgeBps: "10",
      minimumCapacityUsd: "1000",
      estimatedNonFundingCostBps: "2",
      holdingHours: "8",
      crossing: "ineligible-to-eligible",
      researchOnly: true,
      executionPermission: false
    };
    const createReserved = await jsonRequest("", "POST", {
      clientId: "browser.basis-01",
      definition: reservedDefinition
    });
    expect(createReserved.status).toBe(400);
    expect(await createReserved.json()).toEqual({
      error: "Only price-threshold alerts are available in R5.1.",
      code: "unsupported_alert_kind"
    });

    const updateReserved = await jsonRequest(`/${RULE_ID}`, "PUT", {
      expectedRevision: 1,
      definition: reservedDefinition
    });
    expect(updateReserved.status).toBe(400);
    expect(await updateReserved.json()).toMatchObject({
      code: "unsupported_alert_kind"
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["telegram-only", ["telegram"]],
    ["mixed", ["in-app", "telegram"]]
  ] as const)("accepts %s delivery now that the R5.3b telegram lane exists", async (_label, deliveryChannels) => {
    const telegramDefinition = { ...definition, deliveryChannels: [...deliveryChannels] };
    const createResponse = await jsonRequest("", "POST", {
      clientId: "browser.delivery-01",
      definition: telegramDefinition
    });
    expect(createResponse.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER_A,
        definition: expect.objectContaining({ deliveryChannels: [...deliveryChannels] })
      })
    );

    const updateResponse = await jsonRequest(`/${RULE_ID}`, "PUT", {
      expectedRevision: 1,
      definition: telegramDefinition
    });
    expect(updateResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: RULE_ID,
        definition: expect.objectContaining({ deliveryChannels: [...deliveryChannels] })
      })
    );
  });

  it("keeps rejecting unknown delivery channels", async () => {
    const unsupported = { ...definition, deliveryChannels: ["in-app", "email"] };
    const createResponse = await jsonRequest("", "POST", {
      clientId: "browser.delivery-02",
      definition: unsupported
    });
    expect(createResponse.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [new AlertNotFoundError("missing"), 404, "alert_not_found"],
    [new AlertQuotaError("quota"), 429, "alert_quota_exceeded"],
    [new AlertCapacityError("capacity"), 429, "alert_capacity_exceeded"],
    [new AlertIdempotencyConflictError("idempotency"), 409, "alert_idempotency_conflict"],
    [new AlertRevisionConflictError("revision"), 409, "alert_revision_conflict"],
    [new AlertEvaluationConflictError("private authorization detail"), 409, "alert_authorization_changed"]
  ])("maps repository conflicts without leaking them as 500", async (error, status, code) => {
    create.mockRejectedValueOnce(error);
    const response = await jsonRequest("", "POST", {
      clientId: "browser.alert-01",
      definition
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("alert lifecycle public projection", () => {
  it.each([
    [record({ status: "archived" }), "archived"],
    [record({ status: "disabled" }), "triggered"],
    [record({ status: "disabled", definition: { ...definition, enabled: false } }), "disabled"],
    [record({ lastErrorCode: "stale-candle-window" }), "stale"],
    [record({ lastErrorCode: "public_stale_candle_window" }), "stale"],
    [record({ lastErrorCode: "unavailable_stale_candle_window" }), "stale"],
    [record({ lastErrorCode: "upstream-unavailable" }), "error"]
  ] as const)("maps durable state without exposing private fields", (source, lifecycleState) => {
    expect(publicRule(source)).toMatchObject({ lifecycleState });
  });
});

function record(overrides: Partial<AlertRuleRecord> = {}): AlertRuleRecord {
  return {
    id: RULE_ID,
    ownerUserId: OWNER_A,
    clientId: "browser.alert-01",
    status: "active",
    currentRevision: 1,
    authorizationRevision: 7,
    evaluationIntervalSeconds: 60,
    nextEvaluationAt: "2026-07-17T08:01:00.000Z",
    evaluationFailureCount: 0,
    createdAt: "2026-07-17T07:00:00.000Z",
    updatedAt: "2026-07-17T07:30:00.000Z",
    definitionHash: "a".repeat(64),
    definition,
    ...overrides
  };
}

function headers(): Record<string, string> {
  return principalHeaders(OWNER_A, OWNER_A);
}

function principalHeaders(owner: string, expectedOwner?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-test-owner": owner,
    ...(expectedOwner ? { "x-sbv2-expected-user": expectedOwner } : {}),
    ...extra
  };
}

function jsonRequest(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
