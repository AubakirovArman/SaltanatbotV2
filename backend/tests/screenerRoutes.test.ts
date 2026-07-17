import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { createScreenerRouter, publicPreset, SCREENER_REQUEST_BODY_BYTE_LIMIT } from "../src/screener/routes.js";
import {
  ScreenerAuthorizationConflictError,
  ScreenerCapacityError,
  ScreenerIdempotencyConflictError,
  ScreenerNotFoundError,
  ScreenerQuotaError,
  ScreenerRevisionConflictError,
  type ScreenerPresetRecord,
  type ScreenerRepositoryContract
} from "../src/screener/repositoryTypes.js";

const OWNER_A = "00000000-0000-4000-8000-000000000051";
const OWNER_B = "00000000-0000-4000-8000-000000000052";
const PRESET_ID = "00000000-0000-4000-8000-000000000061";
const NOW = Date.parse("2026-07-17T08:00:00.000Z");
const definition: ScreenerDefinitionV1 = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Momentum screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 50,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [
    { kind: "rsi", period: 14, condition: "above", value: "55" },
    { kind: "quote-volume-24h", min: "1000000" }
  ],
  researchOnly: true,
  executionPermission: false
};

let server: Server;
let baseUrl: string;
let repository: ScreenerRepositoryContract;
let create: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let archive: ReturnType<typeof vi.fn>;

describe("owner-scoped screener preset HTTP API", () => {
  beforeAll(async () => {
    create = vi.fn();
    list = vi.fn();
    get = vi.fn();
    update = vi.fn();
    archive = vi.fn();
    repository = { create, list, get, update, archive };
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
    app.use("/api/screener", createScreenerRouter({} as Pool, { repository, now: () => NOW }));
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ code: "internal_error" });
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/screener`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
    get.mockResolvedValue(record());
    create.mockResolvedValue(record());
    update.mockResolvedValue(record({ revision: 2 }));
    archive.mockResolvedValue(record({ archivedAt: "2026-07-17T08:01:00.000Z" }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("requires the session-bound expected owner and gives admins no cross-owner bypass", async () => {
    const missing = await fetch(`${baseUrl}/presets`, { headers: principalHeaders(OWNER_A) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "screener_owner_mismatch" });

    const adminMismatch = await fetch(`${baseUrl}/presets`, {
      headers: principalHeaders(OWNER_A, OWNER_B, { "x-test-app-role": "admin" })
    });
    expect(adminMismatch.status).toBe(409);
    expect(await adminMismatch.json()).toMatchObject({ code: "screener_owner_mismatch" });
    expect(adminMismatch.headers.get("Cache-Control")).toBe("no-store");
    expect(list).not.toHaveBeenCalled();

    const own = await fetch(`${baseUrl}/presets`, {
      headers: principalHeaders(OWNER_A, OWNER_A, { "x-test-app-role": "admin" })
    });
    expect(own.status).toBe(200);
    expect(list).toHaveBeenCalledWith(OWNER_A, 100);
  });

  it("creates, updates and archives presets only as the authenticated owner", async () => {
    const created = await jsonRequest("/presets", "POST", {
      clientId: "browser.screener-01",
      definition
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      authorizationRevision: 7,
      clientId: "browser.screener-01",
      definition
    });
    expect(await created.json()).toMatchObject({ preset: { id: PRESET_ID, revision: 1 } });

    const updated = await jsonRequest(`/presets/${PRESET_ID}`, "PUT", {
      expectedRevision: 1,
      definition: { ...definition, name: "Momentum screen v2" }
    });
    expect(updated.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        presetId: PRESET_ID,
        expectedRevision: 1,
        authorizationRevision: 7
      })
    );

    const archived = await jsonRequest(`/presets/${PRESET_ID}/archive`, "POST", { expectedRevision: 1 });
    expect(archived.status).toBe(200);
    expect(archive).toHaveBeenCalledWith({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      presetId: PRESET_ID,
      expectedRevision: 1,
      authorizationRevision: 7
    });
    expect(await archived.json()).toMatchObject({ preset: { archivedAt: "2026-07-17T08:01:00.000Z" } });

    const invalidId = await jsonRequest("/presets/not-a-uuid", "PUT", { expectedRevision: 1, definition });
    expect(invalidId.status).toBe(400);
    expect(await invalidId.json()).toEqual({ error: "Invalid screener request.", code: "invalid_request" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("returns contract-validated public projections without persistence internals", async () => {
    list.mockResolvedValue([record(), record({ id: "00000000-0000-4000-8000-000000000062", clientId: "browser.screener-02", archivedAt: "2026-07-17T07:45:00.000Z" })]);
    const response = await fetch(`${baseUrl}/presets?limit=2`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(OWNER_A, 2);
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: "screener-preset-list-v1",
      presets: [
        expect.objectContaining({
          id: PRESET_ID,
          clientId: "browser.screener-01",
          revision: 1,
          definition,
          researchOnly: true,
          executionPermission: false
        }),
        expect.objectContaining({
          clientId: "browser.screener-02",
          archivedAt: "2026-07-17T07:45:00.000Z"
        })
      ],
      generatedAt: "2026-07-17T08:00:00.000Z",
      researchOnly: true,
      executionPermission: false
    });
    const serialized = JSON.stringify(body);
    for (const privateName of ["ownerUserId", "authorizationRevision", "definitionHash", "owner_user_id", "definition_hash"]) {
      expect(serialized).not.toContain(privateName);
    }
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    for (const path of ["/presets?limit=0", "/presets?limit=101", "/presets?ownerUserId=x", `/presets/${PRESET_ID}/archive?force=1`]) {
      const invalid = path.includes("archive")
        ? await jsonRequest(path, "POST", { expectedRevision: 1 })
        : await fetch(`${baseUrl}${path}`, { headers: headers() });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "Invalid screener request.", code: "invalid_request" });
    }
  });

  it("rejects malformed, non-object and oversized JSON before repository access", async () => {
    const malformed = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: '{"clientId":'
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_json" });

    const nonObject = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: "[]"
    });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toMatchObject({ code: "invalid_request" });

    const crossOwnerBody = await jsonRequest("/presets", "POST", {
      clientId: "browser.screener-01",
      definition,
      ownerUserId: OWNER_B
    });
    expect(crossOwnerBody.status).toBe(400);

    const oversized = await fetch(`${baseUrl}/presets`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(SCREENER_REQUEST_BODY_BYTE_LIMIT) })
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: `Screener request body exceeds ${SCREENER_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "screener_envelope_too_large"
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [new ScreenerNotFoundError("missing"), 404, "screener_preset_not_found"],
    [new ScreenerQuotaError("quota"), 429, "screener_quota_exceeded"],
    [new ScreenerCapacityError("capacity"), 429, "screener_capacity_exceeded"],
    [new ScreenerIdempotencyConflictError("idempotency"), 409, "screener_idempotency_conflict"],
    [new ScreenerRevisionConflictError("revision"), 409, "screener_revision_conflict"],
    [new ScreenerAuthorizationConflictError("private authorization detail"), 409, "screener_authorization_changed"]
  ])("maps repository conflicts without leaking them as 500", async (error, status, code) => {
    create.mockRejectedValueOnce(error);
    const response = await jsonRequest("/presets", "POST", {
      clientId: "browser.screener-01",
      definition
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never exposes authorization details through the public projection helper", () => {
    const projected = publicPreset(record({ archivedAt: "2026-07-17T08:01:00.000Z" }));
    expect(projected).toEqual({
      id: PRESET_ID,
      clientId: "browser.screener-01",
      revision: 1,
      definition,
      createdAt: "2026-07-17T07:00:00.000Z",
      updatedAt: "2026-07-17T07:30:00.000Z",
      archivedAt: "2026-07-17T08:01:00.000Z",
      researchOnly: true,
      executionPermission: false
    });
  });
});

function record(overrides: Partial<ScreenerPresetRecord> = {}): ScreenerPresetRecord {
  return {
    id: PRESET_ID,
    ownerUserId: OWNER_A,
    clientId: "browser.screener-01",
    revision: 1,
    authorizationRevision: 7,
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
