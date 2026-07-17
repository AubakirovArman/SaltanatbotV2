import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureIdentityAuth } from "../src/auth.js";
import { apiErrorHandler } from "../src/http/apiErrorHandler.js";
import { sessionCookieName } from "../src/identity/http.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import type { IdentityRuntime } from "../src/identity/runtime.js";
import { registerIdentityServerRoutes } from "../src/identity/serverRoutes.js";
import { IdentityService } from "../src/identity/service.js";

const TEMPORARY_PASSWORD = "temporary-Secure-passphrase-2026";
const PERMANENT_PASSWORD = "permanent-Other-passphrase-2026";
let server: Server;
let baseUrl: string;
let ownerUserId: string;
let cookie: string;
let csrfToken: string;
let poolQuery: ReturnType<typeof vi.fn>;

describe("alert API app-auth mount", () => {
  beforeAll(async () => {
    const identity = new IdentityService(new MemoryIdentityRepository());
    const admin = await identity.bootstrapAdmin("alert-admin", TEMPORARY_PASSWORD);
    const temporary = await identity.login(admin.login, TEMPORARY_PASSWORD);
    const temporaryPrincipal = await identity.authenticate(temporary.sessionToken);
    await identity.changePassword(
      temporaryPrincipal!,
      TEMPORARY_PASSWORD,
      PERMANENT_PASSWORD,
    );
    const credentials = await identity.login(admin.login, PERMANENT_PASSWORD);
    ownerUserId = credentials.user.id;
    cookie = `${sessionCookieName}=${encodeURIComponent(credentials.sessionToken)}`;
    csrfToken = credentials.csrfToken;
    configureIdentityAuth(identity);

    poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM alert_rules")) return { rows: [] };
      throw new Error(`Unexpected alert auth-mount query: ${sql}`);
    });
    const runtime: IdentityRuntime = {
      mode: "database",
      service: identity,
      pool: { query: poolQuery } as unknown as Pool,
      async close() {},
    };
    const app = express();
    registerIdentityServerRoutes(app, runtime);
    app.use(apiErrorHandler);
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/alerts`;
  });

  afterAll(async () => {
    configureIdentityAuth(undefined);
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("keeps alerts behind the normal database session and expected-owner guard", async () => {
    const anonymous = await fetch(baseUrl, {
      headers: { "x-sbv2-expected-user": ownerUserId },
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "not_authenticated" });
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");

    const missingExpectedOwner = await fetch(baseUrl, { headers: { cookie } });
    expect(missingExpectedOwner.status).toBe(409);
    expect(await missingExpectedOwner.json()).toMatchObject({
      code: "alert_owner_mismatch",
    });

    const authenticated = await fetch(baseUrl, {
      headers: { cookie, "x-sbv2-expected-user": ownerUserId },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      schemaVersion: "alert-rule-list-v1",
      rules: [],
      researchOnly: true,
      executionPermission: false,
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects alert mutations without the existing session CSRF fence", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-sbv2-expected-user": ownerUserId,
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "invalid_csrf" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(poolQuery).toHaveBeenCalledTimes(1);

    const invalidBodyAfterCsrf = await fetch(baseUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "x-sbv2-expected-user": ownerUserId,
      },
      body: "{}",
    });
    expect(invalidBodyAfterCsrf.status).toBe(400);
    expect(await invalidBodyAfterCsrf.json()).toMatchObject({
      code: "invalid_request",
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});
