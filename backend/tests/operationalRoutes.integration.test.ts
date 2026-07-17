import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureIdentityAuth } from "../src/auth.js";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { apiErrorHandler } from "../src/http/apiErrorHandler.js";
import { GlobalAdmissionController } from "../src/http/globalAdmission.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import type { IdentityRuntime } from "../src/identity/runtime.js";
import { registerIdentityServerRoutes } from "../src/identity/serverRoutes.js";
import { IdentityService } from "../src/identity/service.js";
import { sessionCookieName } from "../src/identity/http.js";
import { ApiMetrics } from "../src/operations/apiMetrics.js";
import { OperationalStatusService } from "../src/operations/statusService.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const ADMIN_TEMPORARY_PASSWORD = "temporary-Admin-password-2026";
const ADMIN_PERMANENT_PASSWORD = "permanent-Admin-password-2026";
const NORMAL_USER_PASSWORD = "normal-user-password-2026";
const RECOVERY_RECEIPT = {
  version: 1,
  generationId: "22222222-2222-4222-8222-222222222222",
  verifiedAt: "2026-07-16T19:00:00.000Z",
  releaseCommit: "b".repeat(40),
  schemaVersion: 11,
  captureSpanMs: 2_345,
  sourceGeneration: "20260716T190000Z"
} as const;
let server: Server;
let baseUrl: string;
let adminCookie: string;
let normalUserCookie: string;
let poolQuery: ReturnType<typeof vi.fn>;
let operationsTemporaryDirectory: string;

describe("operational HTTP route boundaries", () => {
  beforeAll(async () => {
    operationsTemporaryDirectory = mkdtempSync(path.join(tmpdir(), "saltanat-operations-route-"));
    const recoveryStatusFile = path.resolve(operationsTemporaryDirectory, "recovery-status.json");
    writeFileSync(recoveryStatusFile, `${JSON.stringify(RECOVERY_RECEIPT)}\n`, { mode: 0o600 });
    const repository = new MemoryIdentityRepository();
    const identity = new IdentityService(repository);
    const admin = await identity.bootstrapAdmin("operations-admin", ADMIN_TEMPORARY_PASSWORD);
    const temporarySession = await identity.login(admin.login, ADMIN_TEMPORARY_PASSWORD);
    const temporaryPrincipal = await identity.authenticate(temporarySession.sessionToken);
    await identity.changePassword(temporaryPrincipal!, ADMIN_TEMPORARY_PASSWORD, ADMIN_PERMANENT_PASSWORD);
    const adminSession = await identity.login(admin.login, ADMIN_PERMANENT_PASSWORD);
    const adminPrincipal = await identity.authenticate(adminSession.sessionToken);

    const normalUser = await identity.register("operations-user", NORMAL_USER_PASSWORD);
    await identity.activateUser(adminPrincipal!, normalUser.id, {
      reason: "activate normal user for operational route isolation test",
      expectedAuthorizationRevision: normalUser.authorizationRevision
    });
    const normalUserSession = await identity.login(normalUser.login, NORMAL_USER_PASSWORD);

    adminCookie = sessionCookie(adminSession.sessionToken);
    normalUserCookie = sessionCookie(normalUserSession.sessionToken);
    configureIdentityAuth(identity);

    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("schema_migrations")) {
        return {
          rows: [
            {
              version: latestMigration.version,
              checksum: latestMigration.checksum
            }
          ]
        };
      }
      if (sql.includes("runtime_component_heartbeats")) {
        return {
          rows: [
            {
              component: "research-worker",
              generation_id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              started_at: new Date(NOW - 60_000),
              heartbeat_at: new Date(NOW - 1_000),
              release_commit: "abcdef0",
              database_schema_version: latestMigration.version
            }
          ]
        };
      }
      throw new Error(`Unexpected fake PostgreSQL query: ${sql}`);
    });
    const pool = {
      totalCount: 3,
      idleCount: 2,
      waitingCount: 0,
      query: poolQuery
    } as unknown as Pool;
    const runtimeConfig = loadRuntimeConfig({
      NODE_ENV: "test",
      OPERATIONS_RECOVERY_STATUS_FILE: recoveryStatusFile
    } as NodeJS.ProcessEnv);
    const operations = new OperationalStatusService({
      runtimeConfig,
      pool,
      admission: new GlobalAdmissionController(runtimeConfig.operations.admission),
      apiMetrics: new ApiMetrics(),
      executorReady: () => false,
      now: () => NOW,
      readDisk: async () => ({
        freeBytes: 100 * 1_024 ** 3,
        totalBytes: 1_000 * 1_024 ** 3
      })
    });
    const runtime: IdentityRuntime = {
      mode: "database",
      service: identity,
      pool,
      async close() {}
    };
    const app = express();
    registerIdentityServerRoutes(app, runtime, { operations });
    app.use(apiErrorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    configureIdentityAuth(undefined);
    if (server) await closeServer(server);
    if (operationsTemporaryDirectory) {
      rmSync(operationsTemporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps readiness public, no-store, and returns the bounded 503 payload", async () => {
    const response = await fetch(`${baseUrl}/api/ready`);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "unready",
      version: 1,
      ts: NOW,
      components: {
        migrations: { status: "ready" },
        postgres: { status: "ready" },
        executor: { status: "unready" },
        researchWorker: { status: "ready" },
        filesystem: { status: "ready" },
        admission: { status: "ready" }
      }
    });
    const publicPayload = JSON.stringify(await (
      await fetch(`${baseUrl}/api/ready`)
    ).json());
    for (const privateField of [
      "expectedVersion",
      "checksumMatches",
      "probeLatencyMs",
      "heartbeatAgeMs",
      "componentState",
      "freeBytes",
      "freePercent",
      "active",
      "queued",
      "saturation"
    ]) {
      expect(publicPayload).not.toContain(`"${privateField}"`);
    }
    expect(poolQuery).toHaveBeenCalled();
  });

  it("denies anonymous and normal users but serves metrics to the password-changed admin", async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin/operations/metrics`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
    expect(await anonymous.json()).toMatchObject({
      code: "not_authenticated"
    });

    const normalUser = await fetch(`${baseUrl}/api/admin/operations/metrics`, { headers: { cookie: normalUserCookie } });
    expect(normalUser.status).toBe(403);
    expect(normalUser.headers.get("Cache-Control")).toBe("no-store");
    expect(await normalUser.json()).toMatchObject({
      code: "admin_required"
    });

    const admin = await fetch(`${baseUrl}/api/admin/operations/metrics`, { headers: { cookie: adminCookie } });
    expect(admin.status).toBe(200);
    expect(admin.headers.get("Cache-Control")).toBe("no-store");
    const adminPayload = await admin.json();
    expect(adminPayload).toMatchObject({
      version: 1,
      ts: NOW,
      readiness: {
        ok: false,
        status: "unready",
        components: {
          migrations: {
            status: "ready",
            expectedVersion: DATABASE_MIGRATIONS.at(-1)?.version,
            checksumMatches: true
          },
          postgres: {
            status: "ready",
            probeLatencyMs: expect.any(Number)
          },
          executor: { status: "unready" },
          researchWorker: {
            status: "ready",
            heartbeatAgeMs: 1_000,
            componentState: "ready"
          },
          filesystem: {
            status: "ready",
            freeBytes: 100 * 1_024 ** 3,
            freePercent: 10
          },
          admission: {
            status: "ready",
            active: 0,
            queued: 0,
            saturation: 0
          }
        }
      },
      api: {
        requests: 0,
        completed: 0,
        disconnected: 0,
        inFlight: 0
      },
      postgres: {
        totalCount: 3,
        idleCount: 2,
        waitingCount: 0
      },
      researchWorker: {
        status: "ready",
        heartbeatAgeMs: 1_000,
        databaseSchemaVersion: DATABASE_MIGRATIONS.at(-1)?.version,
        releaseCommit: "abcdef0"
      },
      recovery: { lastVerifiedGeneration: RECOVERY_RECEIPT }
    });
    expect(JSON.stringify(adminPayload)).not.toContain(operationsTemporaryDirectory);
  });
});

function sessionCookie(token: string): string {
  return `${sessionCookieName}=${encodeURIComponent(token)}`;
}

function closeServer(instance: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    instance.close((error) => (error ? reject(error) : resolve()));
  });
}
