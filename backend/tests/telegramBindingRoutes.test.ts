import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BINDING_REQUEST_BODY_BYTE_LIMIT, createAlertBindingRouter } from "../src/alerts/bindingRoutes.js";
import {
  BindingCodeQuotaError,
  BindingNotFoundError,
  BindingRevisionConflictError,
  type NotificationBindingPublic
} from "../src/notifications/bindingService.js";

const OWNER_A = "00000000-0000-4000-8000-000000000051";
const OWNER_B = "00000000-0000-4000-8000-000000000052";
const BINDING_ID = "00000000-0000-4000-8000-000000000061";
const NOW = Date.parse("2026-07-17T08:00:00.000Z");

let server: Server;
let baseUrl: string;
let createCode: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;
let now: number;
let testIndex = 0;

describe("owner-scoped telegram binding HTTP API", () => {
  beforeAll(async () => {
    createCode = vi.fn();
    list = vi.fn();
    revoke = vi.fn();
    now = NOW;
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
    app.use(
      "/api/alerts/bindings",
      createAlertBindingRouter({} as Pool, {
        repository: { createCode, list, revoke },
        now: () => now
      })
    );
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ code: "internal_error" });
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/alerts/bindings`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The router-owned rate limiter lives across tests: give every test its
    // own clock hour so no window or block leaks between tests.
    testIndex += 1;
    now = NOW + testIndex * 3_600_000;
    list.mockResolvedValue([binding()]);
    createCode.mockResolvedValue({ id: BINDING_ID, code: "abcdefghijklmnopqrstuv2345", expiresAt: "2026-07-17T08:10:00.000Z" });
    revoke.mockResolvedValue({ binding: binding({ status: "revoked", revokedAt: "2026-07-17T08:05:00.000Z" }), cancelledDeliveries: 2 });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("requires the session-bound expected owner and gives admins no bypass", async () => {
    const missing = await fetch(baseUrl, { headers: principalHeaders(OWNER_A) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "alert_owner_mismatch" });

    const adminMismatch = await fetch(baseUrl, {
      headers: { ...principalHeaders(OWNER_A, OWNER_B), "x-test-app-role": "admin" }
    });
    expect(adminMismatch.status).toBe(409);
    expect(list).not.toHaveBeenCalled();

    const matched = await fetch(baseUrl, { headers: principalHeaders(OWNER_A, OWNER_A) });
    expect(matched.status).toBe(200);
    expect(list).toHaveBeenCalledWith(OWNER_A);
  });

  it("lists bindings with no-store caching and the paper-only envelope", async () => {
    const response = await fetch(baseUrl, { headers: principalHeaders(OWNER_A, OWNER_A) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      bindings: [binding()],
      researchOnly: true,
      executionPermission: false
    });
  });

  it("rejects unknown query parameters", async () => {
    const response = await fetch(`${baseUrl}?limit=10`, { headers: principalHeaders(OWNER_A, OWNER_A) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("returns the raw one-consume code exactly once with its expiry", async () => {
    const response = await postJson(`${baseUrl}/codes`, undefined, OWNER_A);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "abcdefghijklmnopqrstuv2345",
      codeId: BINDING_ID,
      expiresAt: "2026-07-17T08:10:00.000Z",
      researchOnly: true,
      executionPermission: false
    });
    expect(createCode).toHaveBeenCalledWith(OWNER_A);
  });

  it("rejects code requests that carry body fields", async () => {
    const response = await postJson(`${baseUrl}/codes`, { bindingId: BINDING_ID }, OWNER_A);
    expect(response.status).toBe(400);
    expect(createCode).not.toHaveBeenCalled();
  });

  it("rate limits code creation per owner without an admin bypass", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const allowed = await postJson(`${baseUrl}/codes`, undefined, OWNER_A, { "x-test-app-role": "admin" });
      expect(allowed.status).toBe(201);
    }
    const limited = await postJson(`${baseUrl}/codes`, undefined, OWNER_A, { "x-test-app-role": "admin" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ code: "binding_code_rate_limited", retryable: true });
    expect(createCode).toHaveBeenCalledTimes(10);

    // Another owner keeps an independent budget.
    const other = await postJson(`${baseUrl}/codes`, undefined, OWNER_B);
    expect(other.status).toBe(201);

    // The window slides: the same owner may create codes again later.
    now += 11 * 60_000;
    const recovered = await postJson(`${baseUrl}/codes`, undefined, OWNER_A);
    expect(recovered.status).toBe(201);
  });

  it("maps the outstanding-code quota to 429 binding_code_quota_exceeded", async () => {
    createCode.mockRejectedValue(new BindingCodeQuotaError("quota"));
    const response = await postJson(`${baseUrl}/codes`, undefined, OWNER_A);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "binding_code_quota_exceeded" });
  });

  it("revokes with the expected revision and reports cancelled deliveries", async () => {
    const response = await postJson(`${baseUrl}/${BINDING_ID}/revoke`, { expectedRevision: 1 }, OWNER_A);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      binding: binding({ status: "revoked", revokedAt: "2026-07-17T08:05:00.000Z" }),
      cancelledDeliveries: 2
    });
    expect(revoke).toHaveBeenCalledWith({ ownerUserId: OWNER_A, bindingId: BINDING_ID, expectedRevision: 1 });
  });

  it("maps revision conflicts to 409 and unknown bindings to 404", async () => {
    revoke.mockRejectedValueOnce(new BindingRevisionConflictError("changed"));
    const conflict = await postJson(`${baseUrl}/${BINDING_ID}/revoke`, { expectedRevision: 1 }, OWNER_A);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "binding_revision_conflict" });

    revoke.mockRejectedValueOnce(new BindingNotFoundError("missing"));
    const missing = await postJson(`${baseUrl}/${BINDING_ID}/revoke`, { expectedRevision: 1 }, OWNER_A);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "binding_not_found" });
  });

  it("validates the revoke body and binding id strictly", async () => {
    for (const body of [{}, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: "1" }, { expectedRevision: 1, extra: true }, [1]]) {
      const response = await postJson(`${baseUrl}/${BINDING_ID}/revoke`, body, OWNER_A);
      expect(response.status).toBe(400);
    }
    const badId = await postJson(`${baseUrl}/not-a-uuid/revoke`, { expectedRevision: 1 }, OWNER_A);
    expect(badId.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("bounds request bodies and reports invalid JSON", async () => {
    const oversized = await fetch(`${baseUrl}/${BINDING_ID}/revoke`, {
      method: "POST",
      headers: { ...principalHeaders(OWNER_A, OWNER_A), "Content-Type": "application/json" },
      body: `{"expectedRevision": 1, "padding": "${"x".repeat(BINDING_REQUEST_BODY_BYTE_LIMIT)}"}`
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "binding_request_too_large" });

    const invalid = await fetch(`${baseUrl}/${BINDING_ID}/revoke`, {
      method: "POST",
      headers: { ...principalHeaders(OWNER_A, OWNER_A), "Content-Type": "application/json" },
      body: "{not json"
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_json" });
  });
});

function binding(override: Partial<NotificationBindingPublic> = {}): NotificationBindingPublic {
  return {
    id: BINDING_ID,
    status: "active",
    revision: 1,
    recipientHandle: "ab12cd34",
    createdAt: "2026-07-17T07:00:00.000Z",
    activatedAt: "2026-07-17T07:01:00.000Z",
    ...override
  };
}

function principalHeaders(principalId: string, expectedOwner?: string): Record<string, string> {
  return {
    "x-test-owner": principalId,
    ...(expectedOwner ? { "X-SBV2-Expected-User": expectedOwner } : {})
  };
}

async function postJson(url: string, body: unknown, owner: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...principalHeaders(owner, owner), "Content-Type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
