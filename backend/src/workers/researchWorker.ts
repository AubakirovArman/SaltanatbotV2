import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createDatabasePool, loadDatabaseConfig, migrateDatabase, verifyDatabaseConnection } from "../database/index.js";
import { ComputeJobArtifactRetention } from "../jobs/artifactRetention.js";
import { claimJobForExecution, ComputeJobRepository, type ClaimedJob } from "../jobs/repository.js";
import { LeaseGenerationRegistry } from "./leaseGenerationRegistry.js";

const concurrency = boundedEnv("RESEARCH_WORKER_CONCURRENCY", 2, 1, 4);
const timeoutMs = boundedEnv("RESEARCH_JOB_TIMEOUT_MS", 120_000, 5_000, 15 * 60_000);
const memoryMb = boundedEnv("RESEARCH_JOB_MEMORY_MB", 512, 128, 2_048);
const metricsIntervalMs = boundedEnv("RESEARCH_WORKER_METRICS_INTERVAL_MS", 30_000, 5_000, 300_000);
const retentionIntervalMs = boundedEnv("RESEARCH_JOB_RETENTION_INTERVAL_MS", 60_000, 60_000, 3_600_000);
const shutdownTimeoutMs = boundedEnv("RESEARCH_WORKER_SHUTDOWN_TIMEOUT_MS", 20_000, 5_000, 25_000);
const leaseMs = Math.max(30_000, Math.min(timeoutMs + 30_000, 20 * 60_000));
const workerId = `${process.env.HOSTNAME ?? "worker"}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 128);
const pool = createDatabasePool(loadDatabaseConfig());
await verifyDatabaseConnection(pool);
await migrateDatabase(pool);
const repository = new ComputeJobRepository(pool);
const artifactRetention = new ComputeJobArtifactRetention(pool);
await repository.recoverExpiredLeases();
const active = new LeaseGenerationRegistry<{ worker: Worker; shutdown: () => Promise<void> }>();
const setups = new Set<Promise<void>>();
let stopping = false;
let pollPromise: Promise<void> | undefined;
let metricsPromise: Promise<void> | undefined;
let retentionPromise: Promise<void> | undefined;

console.info(JSON.stringify({
  event: "research_worker_ready",
  workerId,
  concurrency,
  timeoutMs,
  taskMemoryMb: memoryMb
}));
// This timer intentionally remains referenced: it is the daemon's idle
// keepalive after PostgreSQL closes idle sockets.
const timer = setInterval(() => void triggerPoll(), 750);
const metricsTimer = setInterval(() => void triggerMetrics(), metricsIntervalMs);
metricsTimer.unref();
const retentionTimer = setInterval(() => void triggerRetention(), retentionIntervalMs);
retentionTimer.unref();
void triggerPoll();
void triggerMetrics();
void triggerRetention();

function triggerPoll(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (pollPromise) return pollPromise;
  const running = poll();
  pollPromise = running;
  void running.finally(() => {
    if (pollPromise === running) pollPromise = undefined;
  });
  return running;
}

async function poll(): Promise<void> {
  try {
    await repository.recoverExpiredLeases();
    while (!stopping && active.size + setups.size < concurrency) {
      const job = await claimJobForExecution(repository, workerId, leaseMs, () => stopping);
      if (!job) break;
      launch(job);
    }
  } catch (error) {
    console.error(`Research worker poll failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launch(job: ClaimedJob): void {
  const setup = execute(job);
  setups.add(setup);
  void setup
    .catch((error) => {
      console.error(`Research job ${job.id} setup failed: ${safeErrorMessage(error, "worker setup error")}`);
    })
    .finally(() => {
      setups.delete(setup);
      void triggerPoll();
    });
}

function triggerMetrics(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (metricsPromise) return metricsPromise;
  const running = repository.getAggregateMetrics()
    .then((metrics) => {
      console.info(JSON.stringify({
        event: "research_queue_metrics",
        workerId,
        activeWorkers: active.size,
        workerConcurrency: concurrency,
        workerSaturation: Math.round((active.size / concurrency) * 1_000) / 1_000,
        ...metrics
      }));
    })
    .catch((error) => {
      console.error(JSON.stringify({
        event: "research_queue_metrics_failed",
        workerId,
        error: safeErrorMessage(error, "database error")
      }));
    });
  metricsPromise = running;
  void running.finally(() => {
    if (metricsPromise === running) metricsPromise = undefined;
  });
  return running;
}

function triggerRetention(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (retentionPromise) return retentionPromise;
  const running = artifactRetention.enforce()
    .then((result) => {
      if (result.artifactsCompacted + result.tombstonesDeleted === 0) return;
      console.info(JSON.stringify({
        event: "research_job_artifact_retention",
        workerId,
        ...result
      }));
    })
    .catch((error) => {
      console.error(JSON.stringify({
        event: "research_job_artifact_retention_failed",
        workerId,
        error: safeErrorMessage(error, "database error")
      }));
    });
  retentionPromise = running;
  void running.finally(() => {
    if (retentionPromise === running) retentionPromise = undefined;
  });
  return running;
}

async function execute(job: ClaimedJob): Promise<void> {
  if (job.jobType !== "backtest") {
    await finalizeFailedClaim(job, "unsupported_job_type", `Unsupported job type: ${job.jobType}`);
    return;
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./backtestTask.js", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, stackSizeMb: 8 }
    });
  } catch (error) {
    await finalizeTransientClaim(job, "worker_start_failed", safeErrorMessage(error, "Unable to start research worker."));
    return;
  }
  let settled = false;
  let heartbeatRunning = false;
  let finishPromise: Promise<void> | undefined;
  const finish = (operation: () => Promise<unknown>): Promise<void> => {
    if (finishPromise) return finishPromise;
    settled = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    finishPromise = (async () => {
      await worker.terminate().catch(() => undefined);
      try {
        await operation();
      } catch (error) {
        console.error(`Research job ${job.id} finalization failed: ${safeErrorMessage(error, "database error")}`);
      } finally {
        active.delete(job.id, job.leaseToken);
        void triggerPoll();
      }
    })();
    return finishPromise;
  };
  const timeout = setTimeout(() => void finish(() => repository.fail(job.id, job.leaseToken, "job_timeout", "Research job exceeded its wall-time limit.")), timeoutMs);
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || settled) return;
    heartbeatRunning = true;
    void repository.cancellationRequested(job.id, job.leaseToken)
      .then((cancelled) => {
        if (cancelled) return finish(() => repository.fail(job.id, job.leaseToken, "cancelled", "Cancelled by user."));
        return repository.heartbeat(job.id, job.leaseToken, leaseMs, 0.5).then((healthy) => {
          if (!healthy) return finish(() => repository.fail(job.id, job.leaseToken, "cancelled", "Cancelled by user."));
        });
      })
      .catch((error) => console.error(`Research heartbeat failed: ${safeErrorMessage(error, "database error")}`))
      .finally(() => { heartbeatRunning = false; });
  }, 5_000);
  active.add(job.id, job.leaseToken, {
    worker,
    shutdown: () => finish(() => repository.requeueForShutdown(job.id, job.leaseToken))
  });
  worker.once("message", (message: unknown) => {
    if (isWorkerSuccess(message)) void finish(() => repository.complete(job.id, job.leaseToken, message.result));
    else void finish(() => repository.fail(job.id, job.leaseToken, "backtest_failed", workerErrorMessage(message)));
  });
  worker.once("error", (error) => void finish(() => repository.retryOrFail(job.id, job.leaseToken, "worker_error", error.message)));
  worker.once("exit", (code) => {
    if (!settled) void finish(() => repository.retryOrFail(job.id, job.leaseToken, "worker_exit", `Worker exited before returning a result (code ${code}).`));
  });
  try {
    worker.postMessage(job.payload);
  } catch (error) {
    await finish(() => repository.retryOrFail(job.id, job.leaseToken, "worker_message_failed", safeErrorMessage(error, "Unable to send the research task.")));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(metricsTimer);
    clearInterval(retentionTimer);
    const forcedExit = setTimeout(() => {
      console.error(JSON.stringify({
        event: "research_worker_shutdown_timeout",
        workerId,
        timeoutMs: shutdownTimeoutMs
      }));
      process.exit(1);
    }, shutdownTimeoutMs);
    const stopActive = Promise.allSettled([...active.values()].map((execution) => execution.shutdown()));
    const finishClaims = Promise.resolve(pollPromise);
    const finishRetention = Promise.resolve(retentionPromise);
    void Promise.allSettled([stopActive, finishClaims, finishRetention])
      .then(() => Promise.allSettled([...setups]))
      .then(() => pool.end())
      .catch((error) => console.error(`Research worker shutdown failed: ${safeErrorMessage(error, "database error")}`))
      .finally(() => {
        clearTimeout(forcedExit);
        process.exit(0);
      });
  });
}

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(Math.min(maximum, Math.max(minimum, value))) : fallback;
}

async function finalizeFailedClaim(job: ClaimedJob, code: string, message: string): Promise<void> {
  try {
    await repository.fail(job.id, job.leaseToken, code, message);
  } catch (error) {
    console.error(`Research job ${job.id} failure could not be persisted: ${safeErrorMessage(error, "database error")}`);
  } finally {
    void triggerPoll();
  }
}

async function finalizeTransientClaim(job: ClaimedJob, code: string, message: string): Promise<void> {
  try {
    await repository.retryOrFail(job.id, job.leaseToken, code, message);
  } catch (error) {
    console.error(`Research job ${job.id} retry could not be persisted: ${safeErrorMessage(error, "database error")}`);
  } finally {
    void triggerPoll();
  }
}

function isWorkerSuccess(value: unknown): value is { ok: true; result: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; result?: unknown };
  return candidate.ok === true && !!candidate.result && typeof candidate.result === "object" && !Array.isArray(candidate.result);
}

function workerErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Backtest worker returned an invalid response.";
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error.slice(0, 4_000) : "Backtest failed.";
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 4_000) : fallback;
}
