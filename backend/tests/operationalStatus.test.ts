import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { GlobalAdmissionController } from "../src/http/globalAdmission.js";
import type { ReadinessRateLimitSnapshot } from "../src/http/readinessRateLimit.js";
import { ApiMetrics } from "../src/operations/apiMetrics.js";
import type { RecoveryStatusReceipt } from "../src/operations/recoveryStatus.js";
import { OperationalStatusService, toPublicOperationalReadiness } from "../src/operations/statusService.js";

const RECOVERY_RECEIPT = {
  version: 1,
  generationId: "22222222-2222-4222-8222-222222222222",
  verifiedAt: "2026-07-16T19:00:00.000Z",
  releaseCommit: "b".repeat(40),
  schemaVersion: 11,
  captureSpanMs: 2_345,
  sourceGeneration: "20260716T190000Z"
} as const satisfies RecoveryStatusReceipt;

describe("operational readiness", () => {
  it("reports ready only when schema, worker, executor, disk and admission agree", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const service = createService({
      now,
      query: async (sql: string) => {
        if (sql.includes("schema_migrations")) {
          const migration = DATABASE_MIGRATIONS.at(-1)!;
          return {
            rows: [{ version: migration.version, checksum: migration.checksum }]
          };
        }
        return {
          rows: [
            {
              component: "research-worker",
              generation_id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              started_at: new Date(now - 60_000),
              heartbeat_at: new Date(now - 1_000),
              release_commit: "abcdef0",
              database_schema_version: DATABASE_MIGRATIONS.at(-1)!.version
            }
          ]
        };
      }
    });

    const readiness = await service.readiness();
    expect(readiness).toMatchObject({
      ok: true,
      status: "ready",
      version: 1,
      components: {
        migrations: { status: "ready", checksumMatches: true },
        postgres: { status: "ready" },
        executor: { status: "ready", mode: "paper-only" },
        researchWorker: { status: "ready", componentState: "ready" },
        filesystem: { status: "ready" },
        admission: { status: "ready" }
      }
    });
  });

  it.each([
    ["schema mismatch", "schema"],
    ["stale worker", "worker"],
    ["missing executor", "executor"],
    ["hard disk watermark", "disk"]
  ] as const)("fails readiness for %s", async (_label, failure) => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const service = createService({
      now,
      executorReady: failure !== "executor",
      freeBytes: failure === "disk" ? 32 * 1_024 ** 2 : 100 * 1_024 ** 3,
      query: async (sql: string) => {
        if (sql.includes("schema_migrations")) {
          const migration = DATABASE_MIGRATIONS.at(-1)!;
          return {
            rows: [
              {
                version: failure === "schema" ? migration.version - 1 : migration.version,
                checksum: migration.checksum
              }
            ]
          };
        }
        return {
          rows: [
            {
              component: "research-worker",
              generation_id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              started_at: new Date(now - 60_000),
              heartbeat_at: new Date(now - (failure === "worker" ? 120_000 : 1_000)),
              release_commit: null,
              database_schema_version: DATABASE_MIGRATIONS.at(-1)!.version
            }
          ]
        };
      }
    });

    const readiness = await service.readiness();
    expect(readiness.ok).toBe(false);
    expect(readiness.status).toBe("unready");
  });

  it("keeps hosts without the notification worker fully ready by default", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    const query = vi.fn(async (sql: string) =>
      sql.includes("schema_migrations")
        ? {
            rows: [
              {
                version: latestMigration.version,
                checksum: latestMigration.checksum
              }
            ]
          }
        : { rows: [readyHeartbeat(now)] }
    );
    const service = createService({ now, query });

    const readiness = await service.readiness();
    expect(readiness).toMatchObject({ ok: true, status: "ready" });
    expect(readiness.components.notificationWorker).toBeUndefined();
    expect(toPublicOperationalReadiness(readiness).components).not.toHaveProperty("notificationWorker");
    expect(
      query.mock.calls.filter(([, values]) => Array.isArray(values) && values.includes("notification-worker"))
    ).toHaveLength(0);
  });

  it("requires a fresh notification worker heartbeat only in required mode", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    const heartbeatRows = new Map<string, unknown[]>([
      ["research-worker", [readyHeartbeat(now)]],
      ["notification-worker", []]
    ]);
    const query = async (sql: string, values?: readonly unknown[]) =>
      sql.includes("schema_migrations")
        ? {
            rows: [
              {
                version: latestMigration.version,
                checksum: latestMigration.checksum
              }
            ]
          }
        : { rows: heartbeatRows.get(String(values?.[0])) ?? [] };
    const runtimeEnv = { OPERATIONS_REQUIRE_NOTIFICATION_WORKER: "1" } as NodeJS.ProcessEnv;

    const missing = await createService({ now, runtimeEnv, query }).readiness();
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe("unready");
    expect(missing.components.notificationWorker).toMatchObject({ status: "unready" });

    heartbeatRows.set("notification-worker", [
      {
        ...readyHeartbeat(now),
        component: "notification-worker",
        generation_id: "22222222-2222-4222-8222-222222222222"
      }
    ]);
    const present = await createService({ now, runtimeEnv, query }).readiness();
    expect(present).toMatchObject({
      ok: true,
      status: "ready",
      components: {
        researchWorker: { status: "ready" },
        notificationWorker: { status: "ready", componentState: "ready" }
      }
    });
    expect(toPublicOperationalReadiness(present).components.notificationWorker).toEqual({ status: "ready" });
  });

  it("reports soft disk pressure as degraded without failing liveness", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const service = createService({
      now,
      freeBytes: 3 * 1_024 ** 3,
      totalBytes: 100 * 1_024 ** 3,
      query: async (sql: string) => {
        if (sql.includes("schema_migrations")) {
          const migration = DATABASE_MIGRATIONS.at(-1)!;
          return {
            rows: [{ version: migration.version, checksum: migration.checksum }]
          };
        }
        return {
          rows: [
            {
              component: "research-worker",
              generation_id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              started_at: new Date(now - 60_000),
              heartbeat_at: new Date(now - 1_000),
              release_commit: null,
              database_schema_version: DATABASE_MIGRATIONS.at(-1)!.version
            }
          ]
        };
      }
    });

    const readiness = await service.readiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.status).toBe("degraded");
    expect(readiness.components.filesystem.status).toBe("degraded");
  });

  it("keeps public readiness free of database names, paths, pids and owner data", async () => {
    const service = createService({
      query: async () => {
        throw new Error("secret database /private/path pid=123 owner=11111111-1111-4111-8111-111111111111");
      }
    });
    const payload = JSON.stringify(await service.readiness());
    expect(payload).not.toContain("secret database");
    expect(payload).not.toContain("/private/path");
    expect(payload).not.toContain("pid");
    expect(payload).not.toContain("owner");
  });

  it("single-flights concurrent readiness callers across database, heartbeat and disk probes", async () => {
    let now = Date.parse("2026-07-16T20:00:00.000Z");
    const databaseGate = deferred();
    const diskGate = deferred();
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    const query = vi.fn(async (sql: string) => {
      await databaseGate.promise;
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
      return { rows: [readyHeartbeat(now)] };
    });
    const readDisk = vi.fn(async () => {
      await diskGate.promise;
      return {
        freeBytes: 100 * 1_024 ** 3,
        totalBytes: 1_000 * 1_024 ** 3
      };
    });
    const service = createService({ now: () => now, query, readDisk });

    const callers = Array.from({ length: 64 }, () => service.readiness());
    expect(new Set(callers).size).toBe(1);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([sql]) => sql.includes("schema_migrations"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes("runtime_component_heartbeats"))).toHaveLength(0);
    expect(readDisk).toHaveBeenCalledOnce();

    databaseGate.resolve();
    diskGate.resolve();
    const results = await Promise.all(callers);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes("runtime_component_heartbeats"))).toHaveLength(1);
    expect(results.every((result) => result === results[0])).toBe(true);

    for (let index = 0; index < 32; index += 1) {
      await service.readiness();
    }
    now += 999;
    await service.readiness();
    expect(query).toHaveBeenCalledTimes(2);
    expect(readDisk).toHaveBeenCalledOnce();

    now += 1;
    await service.readiness();
    expect(query).toHaveBeenCalledTimes(4);
    expect(readDisk).toHaveBeenCalledTimes(2);
  });

  it("does not cache an unexpected readiness failure and retries immediately", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    const query = vi.fn(async (sql: string) =>
      sql.includes("schema_migrations")
        ? {
            rows: [
              {
                version: latestMigration.version,
                checksum: latestMigration.checksum
              }
            ]
          }
        : { rows: [readyHeartbeat(now)] }
    );
    const readDisk = vi.fn(async () => ({
      freeBytes: 100 * 1_024 ** 3,
      totalBytes: 1_000 * 1_024 ** 3
    }));
    let executorCalls = 0;
    const executorReady = vi.fn(() => {
      executorCalls += 1;
      if (executorCalls === 1) throw new Error("unexpected executor probe error");
      return true;
    });
    const service = createService({
      now,
      query,
      readDisk,
      executorReady
    });

    await expect(service.readiness()).rejects.toThrow("unexpected executor probe error");
    await expect(service.readiness()).resolves.toMatchObject({
      ok: true,
      status: "ready"
    });
    expect(executorReady).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(4);
    expect(readDisk).toHaveBeenCalledTimes(2);
  });

  it("keeps a PostgreSQL connection available for auth/control during a readiness flood", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const readinessGate = deferred();
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    let active = 0;
    let authControlQueries = 0;
    const waiting: Array<() => void> = [];

    const acquire = (): Promise<void> => {
      if (active < 2) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiting.push(() => {
          active += 1;
          resolve();
        });
      });
    };
    const release = () => {
      active = Math.max(0, active - 1);
      waiting.shift()?.();
    };
    const query = vi.fn(async (sql: string) => {
      await acquire();
      try {
        if (sql.includes("auth_control")) {
          authControlQueries += 1;
          return { rows: [{ ok: true }] };
        }
        await readinessGate.promise;
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
        return { rows: [readyHeartbeat(now)] };
      } finally {
        release();
      }
    });
    const readDisk = vi.fn(async () => ({
      freeBytes: 100 * 1_024 ** 3,
      totalBytes: 1_000 * 1_024 ** 3
    }));
    const service = createService({ now, query, readDisk });

    const readinessFlood = Array.from({ length: 64 }, () => service.readiness());
    const authControl = query("SELECT auth_control");
    await authControl;

    expect(authControlQueries).toBe(1);
    expect(active).toBe(1);
    expect(waiting).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(2);
    expect(readDisk).toHaveBeenCalledOnce();

    readinessGate.resolve();
    await Promise.all(readinessFlood);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("exposes readiness limiter counters only through administrator metrics", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const latestMigration = DATABASE_MIGRATIONS.at(-1)!;
    const limiterSnapshot: ReadinessRateLimitSnapshot = {
      refillPerSecond: 2,
      burst: 10,
      maxBuckets: 4_096,
      buckets: 7,
      allowed: 41,
      rejected: 9
    };
    const service = createService({
      now,
      readinessRateLimit: { snapshot: () => limiterSnapshot },
      query: async (sql: string) =>
        sql.includes("schema_migrations")
          ? {
              rows: [
                {
                  version: latestMigration.version,
                  checksum: latestMigration.checksum
                }
              ]
            }
          : { rows: [readyHeartbeat(now)] }
    });

    const publicReadiness = await service.readiness();
    expect(publicReadiness).not.toHaveProperty("readinessRateLimit");
    await expect(service.metrics()).resolves.toMatchObject({
      readinessRateLimit: limiterSnapshot
    });
  });

  it("reads optional recovery evidence only for admin metrics, never readiness", async () => {
    const now = Date.parse("2026-07-16T20:00:00.000Z");
    const readRecoveryStatus = vi.fn(() => RECOVERY_RECEIPT);
    const service = createService({
      now,
      runtimeEnv: {
        OPERATIONS_RECOVERY_STATUS_FILE: "/var/lib/saltanatbotv2/recovery-status.json"
      },
      readRecoveryStatus,
      query: async (sql: string) => {
        if (sql.includes("schema_migrations")) {
          const migration = DATABASE_MIGRATIONS.at(-1)!;
          return {
            rows: [{ version: migration.version, checksum: migration.checksum }]
          };
        }
        return {
          rows: [
            {
              component: "research-worker",
              generation_id: "11111111-1111-4111-8111-111111111111",
              status: "ready",
              started_at: new Date(now - 60_000),
              heartbeat_at: new Date(now - 1_000),
              release_commit: null,
              database_schema_version: DATABASE_MIGRATIONS.at(-1)!.version
            }
          ]
        };
      }
    });

    await expect(service.readiness()).resolves.toMatchObject({
      ok: true,
      status: "ready"
    });
    expect(readRecoveryStatus).not.toHaveBeenCalled();

    await expect(service.metrics()).resolves.toMatchObject({
      recovery: { lastVerifiedGeneration: RECOVERY_RECEIPT }
    });
    expect(readRecoveryStatus).toHaveBeenCalledOnce();
    expect(readRecoveryStatus).toHaveBeenCalledWith("/var/lib/saltanatbotv2/recovery-status.json");
  });
});

function createService(options: {
  now?: number | (() => number);
  executorReady?: boolean | (() => boolean);
  freeBytes?: number;
  totalBytes?: number;
  runtimeEnv?: NodeJS.ProcessEnv;
  readRecoveryStatus?: (path: string) => RecoveryStatusReceipt | null;
  readDisk?: () => Promise<{ freeBytes: number; totalBytes: number }>;
  readinessRateLimit?: {
    snapshot(): ReadinessRateLimitSnapshot;
  };
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
}) {
  const pool = {
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    query: (sql: string, values?: readonly unknown[]) => options.query(sql, values)
  } as unknown as Pool;
  return new OperationalStatusService({
    runtimeConfig: loadRuntimeConfig({
      NODE_ENV: "test",
      ...options.runtimeEnv
    } as NodeJS.ProcessEnv),
    pool,
    admission: new GlobalAdmissionController({
      maxActive: 8,
      reservedControlSlots: 2,
      maxQueued: 4,
      queueTimeoutMs: 100
    }),
    apiMetrics: new ApiMetrics(),
    readinessRateLimit: options.readinessRateLimit,
    executorReady: () => (typeof options.executorReady === "function" ? options.executorReady() : (options.executorReady ?? true)),
    now: () => (typeof options.now === "function" ? options.now() : (options.now ?? Date.now())),
    readDisk:
      options.readDisk ??
      (async () => ({
        freeBytes: options.freeBytes ?? 100 * 1_024 ** 3,
        totalBytes: options.totalBytes ?? 1_000 * 1_024 ** 3
      })),
    readRecoveryStatus: options.readRecoveryStatus
  });
}

function readyHeartbeat(now: number) {
  return {
    component: "research-worker",
    generation_id: "11111111-1111-4111-8111-111111111111",
    status: "ready",
    started_at: new Date(now - 60_000),
    heartbeat_at: new Date(now - 1_000),
    release_commit: null,
    database_schema_version: DATABASE_MIGRATIONS.at(-1)!.version
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
