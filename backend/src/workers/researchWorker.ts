import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createDatabasePool, loadDatabaseConfig, migrateDatabase, verifyDatabaseConnection } from "../database/index.js";
import { ComputeJobRepository, type ClaimedJob } from "../jobs/repository.js";

const concurrency = boundedEnv("RESEARCH_WORKER_CONCURRENCY", 2, 1, 4);
const timeoutMs = boundedEnv("RESEARCH_JOB_TIMEOUT_MS", 120_000, 5_000, 15 * 60_000);
const memoryMb = boundedEnv("RESEARCH_JOB_MEMORY_MB", 512, 128, 2_048);
const leaseMs = Math.max(30_000, Math.min(timeoutMs + 30_000, 20 * 60_000));
const workerId = `${process.env.HOSTNAME ?? "worker"}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 128);
const pool = createDatabasePool(loadDatabaseConfig());
await verifyDatabaseConnection(pool);
await migrateDatabase(pool);
const repository = new ComputeJobRepository(pool);
await repository.recoverExpiredLeases();
const active = new Map<string, { worker: Worker; shutdown: () => Promise<void> }>();
let stopping = false;
let polling = false;

console.log(`Research worker ${workerId} ready (concurrency ${concurrency}, timeout ${timeoutMs}ms, task memory ${memoryMb}MiB).`);
const timer = setInterval(() => void poll(), 750);
timer.unref();
void poll();

async function poll(): Promise<void> {
  if (polling || stopping) return;
  polling = true;
  try {
    await repository.recoverExpiredLeases();
    while (!stopping && active.size < concurrency) {
      const job = await repository.claim(workerId, leaseMs);
      if (!job) break;
      void execute(job);
    }
  } catch (error) {
    console.error(`Research worker poll failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    polling = false;
  }
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
    await finalizeFailedClaim(job, "worker_start_failed", safeErrorMessage(error, "Unable to start research worker."));
    return;
  }
  let settled = false;
  let heartbeatRunning = false;
  const finish = async (operation: () => Promise<unknown>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    active.delete(job.id);
    await worker.terminate().catch(() => undefined);
    try {
      await operation();
    } catch (error) {
      console.error(`Research job ${job.id} finalization failed: ${safeErrorMessage(error, "database error")}`);
    }
    void poll();
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
  active.set(job.id, {
    worker,
    shutdown: () => finish(() => repository.requeueForShutdown(job.id, job.leaseToken))
  });
  worker.once("message", (message: unknown) => {
    if (isWorkerSuccess(message)) void finish(() => repository.complete(job.id, job.leaseToken, message.result));
    else void finish(() => repository.fail(job.id, job.leaseToken, "backtest_failed", workerErrorMessage(message)));
  });
  worker.once("error", (error) => void finish(() => repository.fail(job.id, job.leaseToken, "worker_error", error.message)));
  worker.once("exit", (code) => {
    if (!settled) void finish(() => repository.fail(job.id, job.leaseToken, "worker_exit", `Worker exited before returning a result (code ${code}).`));
  });
  try {
    worker.postMessage(job.payload);
  } catch (error) {
    await finish(() => repository.fail(job.id, job.leaseToken, "worker_message_failed", safeErrorMessage(error, "Unable to send the research task.")));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    void Promise.allSettled([...active.values()].map((execution) => execution.shutdown()))
      .then(() => pool.end())
      .catch((error) => console.error(`Research worker shutdown failed: ${safeErrorMessage(error, "database error")}`))
      .finally(() => process.exit(0));
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
    void poll();
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
