import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerAlertDefinitionV1, ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { createAlertRouter, type AlertRepositoryContract } from "../src/alerts/routes.js";
import type { AlertEventPageResult } from "../src/alerts/eventPages.js";
import { AlertRearmUnsupportedError, SCREENER_ALERT_MAX_ACTIVE_GLOBAL, SCREENER_ALERT_MAX_ENABLED_PER_OWNER, ScreenerAlertCapacityError, ScreenerAlertQuotaError, type AlertRuleRecord } from "../src/alerts/repositoryTypes.js";

const OWNER = "00000000-0000-4000-8000-000000000051";
const RULE_ID = "00000000-0000-4000-8000-000000000052";
const NOW = Date.parse("2026-07-17T09:00:00.000Z");

let server: Server;
let baseUrl: string;
let repository: AlertRepositoryContract;
let create: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let archive: ReturnType<typeof vi.fn>;
let rearm: ReturnType<typeof vi.fn>;

describe("screener-kind alert HTTP API", () => {
  beforeAll(async () => {
    create = vi.fn();
    list = vi.fn();
    get = vi.fn();
    update = vi.fn();
    archive = vi.fn();
    rearm = vi.fn();
    repository = {
      create,
      list,
      get,
      update,
      archive,
      rearm,
      listEvents: vi.fn(),
      listOutbox: vi.fn().mockResolvedValue([])
    };
    const app = express();
    app.use((request, response, next) => {
      response.locals.authMode = "database";
      response.locals.authPrincipal = {
        user: { id: request.header("x-test-owner"), appRole: "user", authorizationRevision: 7 }
      };
      next();
    });
    app.use(
      "/api/alerts",
      createAlertRouter({} as Pool, {
        repository,
        eventPageReader: { list: vi.fn().mockResolvedValue({ events: [], nextOwnerSequence: "0", hasMore: false, generatedAt: new Date(NOW).toISOString() } satisfies AlertEventPageResult) },
        now: () => NOW
      })
    );
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
    list.mockResolvedValue([record()]);
    get.mockResolvedValue(record());
    create.mockResolvedValue(record());
    update.mockResolvedValue(record({ currentRevision: 2 }));
    archive.mockResolvedValue(record({ status: "archived", archivedAt: "2026-07-17T09:01:00.000Z" }));
    rearm.mockResolvedValue(record({ currentRevision: 2 }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("creates and updates screener-kind rules through the shared contract gate", async () => {
    const created = await jsonRequest("", "POST", {
      clientId: "browser.screen-01",
      definition: definition()
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      authorizationRevision: 7,
      clientId: "browser.screen-01",
      definition: definition()
    });
    expect((await created.json()).rule).toMatchObject({
      schemaVersion: "alert-rule-record-v1",
      id: RULE_ID,
      lifecycleState: "armed",
      definition: { kind: "screener", repeat: "on-change" },
      researchOnly: true,
      executionPermission: false
    });

    const updated = await jsonRequest(`/${RULE_ID}`, "PUT", {
      expectedRevision: 1,
      definition: definition({ enabled: false })
    });
    expect(updated.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER,
        ruleId: RULE_ID,
        expectedRevision: 1,
        definition: expect.objectContaining({ kind: "screener", enabled: false })
      })
    );

    const listed = await fetch(baseUrl, { headers: headers() });
    expect(listed.status).toBe(200);
    expect((await listed.json()).rules[0].definition.screen.timeframe).toBe("5m");
  });

  it("keeps rejecting reserved non-screener kinds and unknown kinds", async () => {
    const reserved = await jsonRequest("", "POST", {
      clientId: "browser.basis-01",
      definition: {
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
      }
    });
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toMatchObject({ code: "unsupported_alert_kind" });

    const unknown = await jsonRequest("", "POST", {
      clientId: "browser.unknown-01",
      definition: { ...definition(), kind: "screener-v2" }
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["telegram-only", ["telegram"]],
    ["mixed", ["in-app", "telegram"]]
  ] as const)("rejects %s delivery on screener rules until R5.3b", async (_label, deliveryChannels) => {
    const response = await jsonRequest("", "POST", {
      clientId: "browser.screen-02",
      definition: definition({ deliveryChannels: [...deliveryChannels] })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unsupported_alert_delivery_channel" });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps a screener rearm attempt to 409 alert_rearm_unsupported", async () => {
    rearm.mockRejectedValueOnce(new AlertRearmUnsupportedError("Screener alerts repeat on change and never need rearming."));
    const response = await jsonRequest(`/${RULE_ID}/rearm`, "POST", { expectedRevision: 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Screener alerts repeat on change and never need rearming.",
      code: "alert_rearm_unsupported"
    });
    expect(rearm).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE_ID }));
  });

  it.each([
    [new ScreenerAlertQuotaError(`At most ${SCREENER_ALERT_MAX_ENABLED_PER_OWNER} screener alert rules may be enabled per owner.`), "screener_alert_quota_exceeded"],
    [new ScreenerAlertCapacityError("capacity"), "screener_alert_capacity_exhausted"]
  ])("maps screener quota pressure to a typed 429 without leaking internals", async (error, code) => {
    create.mockRejectedValueOnce(error);
    const response = await jsonRequest("", "POST", {
      clientId: "browser.screen-03",
      definition: definition()
    });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({ code });
    if (code === "screener_alert_capacity_exhausted") {
      expect(body.error).toContain(String(SCREENER_ALERT_MAX_ACTIVE_GLOBAL));
    }
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

function screen(): ScreenerDefinitionV1 {
  return {
    schemaVersion: "screener-definition-v1",
    kind: "technical",
    name: "Momentum screen",
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    timeframe: "5m",
    universeLimit: 10,
    sort: { key: "symbol", direction: "asc" },
    filters: [{ kind: "price", min: "100", max: "200" }],
    researchOnly: true,
    executionPermission: false
  };
}

function definition(override: Partial<ScreenerAlertDefinitionV1> = {}): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Momentum screen alert",
    enabled: true,
    cooldownSeconds: 3_600,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    screen: screen(),
    repeat: "on-change",
    ...override
  };
}

function record(overrides: Partial<AlertRuleRecord> = {}): AlertRuleRecord {
  return {
    id: RULE_ID,
    ownerUserId: OWNER,
    clientId: "browser.screen-01",
    status: "active",
    currentRevision: 1,
    authorizationRevision: 7,
    evaluationIntervalSeconds: 300,
    nextEvaluationAt: "2026-07-17T09:05:00.000Z",
    evaluationFailureCount: 0,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:30:00.000Z",
    definitionHash: "a".repeat(64),
    definition: definition(),
    ...overrides
  };
}

function headers(): Record<string, string> {
  return { "x-test-owner": OWNER, "x-sbv2-expected-user": OWNER };
}

function jsonRequest(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
