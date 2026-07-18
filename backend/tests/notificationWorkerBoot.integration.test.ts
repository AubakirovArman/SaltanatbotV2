import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { LATEST_DATABASE_SCHEMA_VERSION } from "../src/database/schema.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

/**
 * Boots the real notification worker as a child process against the isolated
 * test database and proves the idle-not-crash contract: a token-less or
 * schema-mismatched host keeps heartbeating and shuts down cleanly.
 */

const connectionString = process.env.TELEGRAM_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WORKER_ENTRY = path.join(REPO_ROOT, "backend/src/workers/notificationWorker.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");
const FUTURE_MIGRATION_VERSION = 1_000;
// Shared with telegramIngressPostgres.integration.test.ts: the fake future
// schema row below must never be visible to a concurrently migrating suite,
// so both telegram PG suites serialize on one session advisory lock.
const TELEGRAM_SUITE_ADVISORY_LOCK = 7_431_053;
let pool: Pool;
let suiteLock: PoolClient | undefined;
const children: ChildProcess[] = [];
const directories: string[] = [];

interface WorkerHandle {
  child: ChildProcess;
  events: Array<Record<string, unknown>>;
  waitFor(event: string, predicate?: (entry: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  stop(): Promise<number | null>;
}

describePostgres("notification worker boot against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 4 });
    await assertIsolatedTestDatabase(pool, process.env.TELEGRAM_TEST_DATABASE_URL ? "TELEGRAM_TEST_DATABASE_URL" : "ALERTS_TEST_DATABASE_URL");
    suiteLock = await pool.connect();
    await suiteLock.query("SELECT pg_advisory_lock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]);
    await migrateDatabase(pool);
  }, 180_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM runtime_component_heartbeats WHERE component = 'notification-worker'");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", [FUTURE_MIGRATION_VERSION]);
  });

  afterAll(async () => {
    await suiteLock?.query("SELECT pg_advisory_unlock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]).catch(() => undefined);
    suiteLock?.release();
    await pool?.end();
  });

  it("idles without a token while heartbeating ready, then shuts down cleanly", { timeout: 40_000 }, async () => {
    const worker = bootWorker({});

    const started = await worker.waitFor("notification_worker_started");
    expect(started).toMatchObject({
      lane: "idle",
      databaseSchemaVersion: LATEST_DATABASE_SCHEMA_VERSION,
      expectedSchemaVersion: LATEST_DATABASE_SCHEMA_VERSION
    });
    const idle = await worker.waitFor("notification_worker_idle");
    expect(idle).toMatchObject({ reason: "token_not_configured" });

    const heartbeat = await waitForHeartbeat();
    expect(heartbeat).toMatchObject({ status: "ready", database_schema_version: LATEST_DATABASE_SCHEMA_VERSION });

    await expect(worker.stop()).resolves.toBe(0);
    const stopped = await pool.query<{ status: string }>("SELECT status FROM runtime_component_heartbeats WHERE component = 'notification-worker'");
    expect(stopped.rows[0]).toEqual({ status: "stopped" });
  });

  it("idles on an invalid token file with the typed reason instead of crash-looping", { timeout: 40_000 }, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "notification-worker-token-"));
    directories.push(directory);
    const tokenPath = path.join(directory, "telegram_bot_token");
    writeFileSync(tokenPath, "1234567890:AAf1e2d3c4b5a6978877665544332211aab", { mode: 0o600 });
    chmodSync(tokenPath, 0o644);
    const worker = bootWorker({ TELEGRAM_BOT_TOKEN_FILE: tokenPath });

    const idle = await worker.waitFor("notification_worker_idle");
    expect(idle).toMatchObject({ reason: "token_wrong_mode" });
    expect(JSON.stringify(worker.events)).not.toContain("AAf1e2d3c4b5a697");

    await expect(worker.stop()).resolves.toBe(0);
  });

  it("refuses to run lanes when the database schema is not this build's version", { timeout: 40_000 }, async () => {
    // A durably newer schema simulates a not-yet-upgraded worker binary.
    await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'test_future_schema_pin', $2)", [FUTURE_MIGRATION_VERSION, "f".repeat(64)]);
    const worker = bootWorker({});
    try {
      const idle = await worker.waitFor("notification_worker_idle");
      expect(idle).toMatchObject({ reason: "schema_version_mismatch", databaseSchemaVersion: FUTURE_MIGRATION_VERSION });
      const started = await worker.waitFor("notification_worker_started");
      expect(started).toMatchObject({ lane: "idle" });
      const heartbeat = await waitForHeartbeat();
      expect(heartbeat).toMatchObject({ status: "ready", database_schema_version: FUTURE_MIGRATION_VERSION });
      await expect(worker.stop()).resolves.toBe(0);
    } finally {
      await pool.query("DELETE FROM schema_migrations WHERE version = $1", [FUTURE_MIGRATION_VERSION]);
    }
  });
});

function bootWorker(extraEnv: Record<string, string>): WorkerHandle {
  const child = spawn(TSX_BIN, [WORKER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      RUNTIME_PROFILE: "public-http-paper",
      AUTH_MODE: "database",
      DATABASE_URL: connectionString!,
      NOTIFICATION_WORKER_HEARTBEAT_INTERVAL_MS: "5000",
      NOTIFICATION_WORKER_IDLE_RECHECK_MS: "5000",
      NOTIFICATION_WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ event: string; predicate?: (entry: Record<string, unknown>) => boolean; resolve: (entry: Record<string, unknown>) => void }> = [];
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let buffered = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        events.push(entry);
        for (const waiter of waiters.splice(0)) {
          if (waiter.event === entry.event && (!waiter.predicate || waiter.predicate(entry))) waiter.resolve(entry);
          else waiters.push(waiter);
        }
      } catch {
        // Non-JSON output is irrelevant to the boot contract.
      }
    }
  });
  return {
    child,
    events,
    waitFor(event, predicate) {
      const existing = events.find((entry) => entry.event === event && (!predicate || predicate(entry)));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}. stderr: ${stderr.slice(0, 2_000)}`)), 30_000);
        waiters.push({
          event,
          ...(predicate ? { predicate } : {}),
          resolve: (entry) => {
            clearTimeout(timer);
            resolve(entry);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Worker exited with ${code} before ${event}. stderr: ${stderr.slice(0, 2_000)}`));
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      });
    }
  };
}

async function waitForHeartbeat(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await pool.query(
      `SELECT status, database_schema_version::int AS database_schema_version
       FROM runtime_component_heartbeats WHERE component = 'notification-worker'`
    );
    if (result.rows[0]) return result.rows[0] as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the notification-worker heartbeat row.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
