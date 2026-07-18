import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "../config/runtimeConfig.js";
import { createDatabasePool, LATEST_DATABASE_SCHEMA_VERSION, loadDatabaseConfig, verifyDatabaseConnection } from "../database/index.js";
import { TelegramDeliveryLane } from "../notifications/deliveryLane.js";
import { TelegramIngressLane } from "../notifications/ingressLane.js";
import { createTelegramIngressRateLimits, createTelegramSendRateLimits } from "../notifications/rateLimits.js";
import { TelegramApi } from "../notifications/telegramApi.js";
import { readTelegramBotTokenFile, TELEGRAM_TOKEN_FILE_ENV } from "../notifications/tokenFile.js";
import { RuntimeComponentHeartbeatRepository } from "../operations/componentHeartbeat.js";

/**
 * Telegram notification worker.
 *
 * Egress-only companion daemon: no HTTP listener, no trading SQLite, and —
 * unlike the research worker — NO migrations. It only reads the current
 * schema_migrations version and refuses (idles while still heartbeating) when
 * the database does not match this build. A missing or invalid
 * TELEGRAM_BOT_TOKEN_FILE likewise idles the worker with a structured reason
 * and a 60s recheck instead of a crash loop, so token-less hosts stay green.
 * The raw token never reaches logs; the bot is identified everywhere by
 * sha256(token).
 */

process.env.PGAPPNAME ??= "saltanatbotv2-notification-worker";
loadRuntimeConfig(process.env);
const heartbeatIntervalMs = boundedEnv("NOTIFICATION_WORKER_HEARTBEAT_INTERVAL_MS", 15_000, 5_000, 60_000);
const idleRecheckMs = boundedEnv("NOTIFICATION_WORKER_IDLE_RECHECK_MS", 60_000, 5_000, 300_000);
const deliveryPollMs = boundedEnv("NOTIFICATION_DELIVERY_POLL_INTERVAL_MS", 1_000, 250, 60_000);
const shutdownTimeoutMs = boundedEnv("NOTIFICATION_WORKER_SHUTDOWN_TIMEOUT_MS", 20_000, 5_000, 25_000);
const MIN_INGRESS_BACKOFF_MS = 1_000;
const MAX_INGRESS_BACKOFF_MS = 30_000;
const generationId = randomUUID();
const workerId = `${process.env.HOSTNAME ?? "notification"}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 128);
const releaseCommit = optionalReleaseCommit(process.env.RELEASE_COMMIT);
const pool = createDatabasePool(loadDatabaseConfig());
await verifyDatabaseConnection(pool);
const componentHeartbeat = new RuntimeComponentHeartbeatRepository(pool);

interface ActiveLanes {
  readonly botFingerprint: string;
  readonly deliveryLane: TelegramDeliveryLane;
  readonly ingressLane: TelegramIngressLane;
  ingressLoop?: Promise<void>;
}

let stopping = false;
let schemaVersion = 0;
let registeredHeartbeatVersion = 0;
let activeLanes: ActiveLanes | undefined;
let supervisorPromise: Promise<void> | undefined;
let heartbeatPromise: Promise<void> | undefined;
let deliveryPromise: Promise<void> | undefined;

await triggerSupervisor();
console.info(
  JSON.stringify({
    event: "notification_worker_started",
    workerId,
    databaseSchemaVersion: schemaVersion,
    expectedSchemaVersion: LATEST_DATABASE_SCHEMA_VERSION,
    lane: activeLanes ? "active" : "idle"
  })
);
// The supervisor interval is the daemon's referenced keepalive timer.
const supervisorTimer = setInterval(() => void triggerSupervisor(), idleRecheckMs);
const heartbeatTimer = setInterval(() => void triggerHeartbeat(), heartbeatIntervalMs);
heartbeatTimer.unref();
const deliveryTimer = setInterval(() => void triggerDeliverySweep(), deliveryPollMs);
deliveryTimer.unref();
void triggerHeartbeat();

function triggerSupervisor(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (supervisorPromise) return supervisorPromise;
  const running = superviseOnce().catch((error) => {
    console.error(JSON.stringify({ event: "notification_worker_supervisor_failed", workerId, error: safeErrorMessage(error, "supervisor error") }));
  });
  supervisorPromise = running;
  void running.finally(() => {
    if (supervisorPromise === running) supervisorPromise = undefined;
  });
  return running;
}

/**
 * The 60s control loop: refresh the observed schema version, re-register the
 * heartbeat when the version moved, re-read the token file, and start or stop
 * the Telegram lanes accordingly. Every idle cause is reported, none crashes.
 */
async function superviseOnce(): Promise<void> {
  schemaVersion = await readCurrentSchemaVersion();
  await registerHeartbeat();
  if (schemaVersion !== LATEST_DATABASE_SCHEMA_VERSION) {
    await deactivateLanes();
    reportIdle("schema_version_mismatch");
    return;
  }
  const token = readTelegramBotTokenFile(process.env[TELEGRAM_TOKEN_FILE_ENV]);
  if (!token.ok) {
    await deactivateLanes();
    reportIdle(`token_${token.reason}`);
    return;
  }
  if (activeLanes?.botFingerprint === token.botFingerprint) return;
  await deactivateLanes();
  const api = new TelegramApi(token.token);
  try {
    await api.getMe();
  } catch (error) {
    reportIdle("telegram_auth_failed", safeErrorMessage(error, "telegram error"));
    return;
  }
  const onError = (error: unknown, phase: string) => {
    console.error(JSON.stringify({ event: "notification_worker_lane_error", workerId, phase, error: safeErrorMessage(error, "lane error") }));
  };
  const lanes: ActiveLanes = {
    botFingerprint: token.botFingerprint,
    deliveryLane: new TelegramDeliveryLane(pool, { workerId, api, limits: createTelegramSendRateLimits(), onError }),
    ingressLane: new TelegramIngressLane(pool, { workerId, api, botFingerprint: token.botFingerprint, limits: createTelegramIngressRateLimits(), onError })
  };
  activeLanes = lanes;
  lanes.ingressLoop = runIngressLoop(lanes);
  console.info(JSON.stringify({ event: "notification_worker_lanes_active", workerId, botFingerprint: token.botFingerprint }));
}

function reportIdle(reason: string, detail?: string): void {
  console.info(
    JSON.stringify({
      event: "notification_worker_idle",
      workerId,
      reason,
      databaseSchemaVersion: schemaVersion,
      expectedSchemaVersion: LATEST_DATABASE_SCHEMA_VERSION,
      ...(detail ? { detail } : {})
    })
  );
}

async function deactivateLanes(): Promise<void> {
  const lanes = activeLanes;
  if (!lanes) return;
  activeLanes = undefined;
  await lanes.ingressLoop?.catch(() => undefined);
  await lanes.ingressLane.release();
}

/** Continuous long-poll driver; exits when the lane is deactivated. */
async function runIngressLoop(lanes: ActiveLanes): Promise<void> {
  let backoff = MIN_INGRESS_BACKOFF_MS;
  while (!stopping && activeLanes === lanes) {
    try {
      const result = await lanes.ingressLane.sweep();
      backoff = MIN_INGRESS_BACKOFF_MS;
      if (result.activated + result.invalidCodes + result.rateLimited + result.replied > 0) {
        console.info(JSON.stringify({ event: "notification_worker_ingress_sweep", workerId, ...result }));
      }
      if (!result.held) await sleep(Math.min(idleRecheckMs, 15_000));
    } catch (error) {
      console.error(JSON.stringify({ event: "notification_worker_ingress_poll_failed", workerId, error: safeErrorMessage(error, "ingress poll error") }));
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_INGRESS_BACKOFF_MS);
    }
  }
}

function triggerDeliverySweep(): Promise<void> {
  if (stopping || !activeLanes) return Promise.resolve();
  if (deliveryPromise) return deliveryPromise;
  const lanes = activeLanes;
  const running = lanes.deliveryLane.sweep().then((result) => {
    if (result.claimed + result.deadLettered + result.cancelled + result.recoveredLeases > 0) {
      console.info(JSON.stringify({ event: "notification_worker_delivery_sweep", workerId, ...result }));
    }
  });
  deliveryPromise = running;
  void running.finally(() => {
    if (deliveryPromise === running) deliveryPromise = undefined;
  });
  return running;
}

/** Upsert the heartbeat whenever the observed schema version changes. */
async function registerHeartbeat(): Promise<void> {
  if (schemaVersion < 1 || schemaVersion === registeredHeartbeatVersion) return;
  try {
    await componentHeartbeat.start({
      component: "notification-worker",
      generationId,
      status: "ready",
      releaseCommit,
      databaseSchemaVersion: schemaVersion
    });
    registeredHeartbeatVersion = schemaVersion;
  } catch (error) {
    console.error(JSON.stringify({ event: "notification_worker_component_heartbeat_failed", workerId, error: safeErrorMessage(error, "database error") }));
  }
}

function triggerHeartbeat(): Promise<void> {
  if (stopping || registeredHeartbeatVersion === 0) return Promise.resolve();
  if (heartbeatPromise) return heartbeatPromise;
  const running = componentHeartbeat
    .pulse("notification-worker", generationId, "ready")
    .then((updated) => {
      if (updated) return;
      console.error(JSON.stringify({ event: "notification_worker_component_heartbeat_rejected", workerId }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ event: "notification_worker_component_heartbeat_failed", workerId, error: safeErrorMessage(error, "database error") }));
    });
  heartbeatPromise = running;
  void running.finally(() => {
    if (heartbeatPromise === running) heartbeatPromise = undefined;
  });
  return running;
}

/** Observed (not migrated) schema version; 0 when the ledger does not exist yet. */
async function readCurrentSchemaVersion(): Promise<number> {
  try {
    const result = await pool.query<{ version: string | number | null }>("SELECT max(version) AS version FROM schema_migrations");
    const raw = result.rows[0]?.version;
    if (raw === null || raw === undefined) return 0;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "42P01") return 0;
    throw error;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(supervisorTimer);
    clearInterval(heartbeatTimer);
    clearInterval(deliveryTimer);
    const forcedExit = setTimeout(() => {
      console.error(JSON.stringify({ event: "notification_worker_shutdown_timeout", workerId, timeoutMs: shutdownTimeoutMs }));
      process.exit(1);
    }, shutdownTimeoutMs);
    void (async () => {
      try {
        if (registeredHeartbeatVersion > 0) {
          await componentHeartbeat.mark("notification-worker", generationId, "draining").catch(() => undefined);
        }
        await Promise.allSettled([supervisorPromise, heartbeatPromise, deliveryPromise]);
        await deactivateLanes();
        if (registeredHeartbeatVersion > 0) {
          await componentHeartbeat.mark("notification-worker", generationId, "stopped").catch(() => undefined);
        }
        await pool.end();
      } catch (error) {
        console.error(JSON.stringify({ event: "notification_worker_shutdown_failed", workerId, error: safeErrorMessage(error, "shutdown error") }));
      } finally {
        clearTimeout(forcedExit);
        process.exit(0);
      }
    })();
  });
}

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 4_000) : fallback;
}

function optionalReleaseCommit(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[0-9a-f]{7,64}$/.test(normalized)) {
    throw new Error("RELEASE_COMMIT must be a lowercase hexadecimal Git commit identifier");
  }
  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
