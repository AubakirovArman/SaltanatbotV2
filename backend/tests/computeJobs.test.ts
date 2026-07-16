import express from "express";
import type { Server } from "node:http";
import type { BacktestResult } from "@saltanatbotv2/backtest-core";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { claimJobForExecution, ComputeJobRepository, type ClaimedJob, JobIdempotencyConflictError } from "../src/jobs/repository.js";
import { MAX_COMPUTE_JOB_RESULT_BYTES, serializeComputeJobResult } from "../src/jobs/resultPayload.js";
import { createComputeJobsRouter } from "../src/jobs/routes.js";
import { compactBacktestReport, parseBacktestTask } from "../src/workers/backtestProtocol.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000002";

interface RecordedQuery {
  text: string;
  values: readonly unknown[];
}

function jobRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: JOB_ID,
    owner_user_id: OWNER_ID,
    job_type: "backtest",
    status: "queued",
    payload: { kind: "backtest" },
    result: null,
    error_code: null,
    error_message: null,
    progress: 0,
    estimated_cost: "10",
    attempt: 0,
    max_attempts: 2,
    cancel_requested_at: null,
    created_at: now,
    started_at: null,
    completed_at: null,
    artifacts_pruned_at: null,
    updated_at: now,
    lease_token: null,
    client_request_id: null,
    dedupe_key: "same-job",
    ...overrides
  };
}

function fakePool(responder: (text: string, values: readonly unknown[]) => { rows?: unknown[]; rowCount?: number }): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    const result = responder(text, values);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    queries
  };
}

describe("durable compute job repository", () => {
  it("returns a deduplicated job before applying the active-job quota", async () => {
    const existing = jobRow();
    const database = fakePool((text) => {
      if (text.includes("dedupe_key = $3")) return { rows: [existing] };
      if (text.includes("count(*)")) throw new Error("quota query must not run for a duplicate");
      return {};
    });

    const job = await new ComputeJobRepository(database.pool).enqueue({
      ownerUserId: OWNER_ID,
      jobType: "backtest",
      payload: { kind: "backtest" },
      estimatedCost: 10,
      dedupeKey: "same-job"
    });

    expect(job.id).toBe(JOB_ID);
    expect(database.queries.some((query) => query.text.includes("count(*)"))).toBe(false);
    expect(database.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects reuse of a client request ID for different content", async () => {
    const existing = jobRow({ client_request_id: "request-0001", dedupe_key: "old-content" });
    const database = fakePool((text) => (text.includes("client_request_id = $2") ? { rows: [existing] } : {}));

    await expect(
      new ComputeJobRepository(database.pool).enqueue({
        ownerUserId: OWNER_ID,
        jobType: "backtest",
        payload: { kind: "backtest" },
        estimatedCost: 10,
        clientRequestId: "request-0001",
        dedupeKey: "new-content"
      })
    ).rejects.toBeInstanceOf(JobIdempotencyConflictError);

    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(database.queries.some((query) => query.text.includes("INSERT INTO compute_jobs"))).toBe(false);
  });

  it("does not collapse a new exact request ID through content dedupe", async () => {
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2")) return {};
      if (text.includes("dedupe_key = $3")) throw new Error("content dedupe must not replace an exact request ID");
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        return {
          rows: [
            jobRow({
              id: values[0],
              payload: JSON.parse(String(values[3])),
              estimated_cost: String(values[4]),
              client_request_id: values[5],
              dedupe_key: values[6]
            })
          ]
        };
      }
      return {};
    });

    const job = await new ComputeJobRepository(database.pool).enqueue({
      ownerUserId: OWNER_ID,
      jobType: "backtest",
      payload: { kind: "backtest" },
      estimatedCost: 10,
      clientRequestId: "request-0002",
      dedupeKey: "same-job"
    });

    expect(job.id).not.toBe(JOB_ID);
    expect(database.queries.some((query) => query.text.includes("dedupe_key = $3"))).toBe(false);
    expect(database.queries.some((query) => query.text.includes("INSERT INTO compute_jobs"))).toBe(true);
  });

  it("uses owner locking, one-running rechecks and fair queue rotation when claiming", async () => {
    const database = fakePool((text, values) => {
      if (text.includes("UPDATE compute_jobs j SET")) {
        expect(text).toContain("DISTINCT ON (j.owner_user_id)");
        expect(text).toContain("pg_try_advisory_xact_lock");
        expect(text.match(/active\.status = 'running'/g)).toHaveLength(2);
        expect(text).toContain("run_after = GREATEST(pending.run_after, clock_timestamp())");
        expect(text).toContain("error_code = NULL");
        expect(values[3]).toEqual(expect.any(Number));
        return { rows: [jobRow({ status: "running", attempt: 1, lease_token: values[1] })] };
      }
      return {};
    });

    const claimed = await new ComputeJobRepository(database.pool).claim("worker-1", 30_000);

    expect(claimed).toMatchObject({ id: JOB_ID, status: "running", attempt: 1, payload: { kind: "backtest" } });
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps list responses bounded by omitting large payload and result details", async () => {
    const database = fakePool((text, values) => {
      expect(text).toContain("NULL::jsonb AS payload");
      expect(text).toContain("NULL::jsonb AS result");
      expect(values).toEqual([OWNER_ID, 100]);
      return {
        rows: [
          jobRow({
            status: "completed",
            payload: null,
            result: null,
            artifacts_pruned_at: new Date("2026-07-14T00:00:00.000Z")
          })
        ]
      };
    });

    const jobs = await new ComputeJobRepository(database.pool).list(OWNER_ID, 10_000);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty("payload");
    expect(jobs[0]).not.toHaveProperty("result");
    expect(jobs[0]).toMatchObject({
      artifactsExpired: true,
      artifactsPrunedAt: "2026-07-14T00:00:00.000Z"
    });
  });

  it("returns bounded owner-scoped queue, duration and failure metrics", async () => {
    const database = fakePool((text, values) => {
      expect(text.match(/owner_user_id = \$1/g)).toHaveLength(2);
      expect(text).toContain("percentile_cont(0.95)");
      expect(text).toContain("LIMIT 10001");
      expect(text).toContain("LIMIT 10000");
      expect(text).toContain("statement_timestamp() AS observed_at");
      expect(text).toContain("AS terminal_cutoff");
      expect(text).toContain("completed_at >= (SELECT terminal_cutoff FROM metric_clock)");
      expect(text).not.toContain("completed_at >= clock_timestamp()");
      expect(values).toEqual([OWNER_ID]);
      return {
        rows: [
          {
            queue_depth: "2",
            running: "1",
            completed: "7",
            failed: "3",
            cancelled: "4",
            duration_samples: "7",
            oldest_queued_age_seconds: 12.34567,
            average_duration_seconds: 1.23456,
            p95_duration_seconds: 2.34567,
            terminal_sample_truncated: true
          }
        ]
      };
    });

    await expect(new ComputeJobRepository(database.pool).getOwnerMetrics(OWNER_ID)).resolves.toEqual({
      queueDepth: 2,
      running: 1,
      completed: 7,
      failed: 3,
      cancelled: 4,
      terminalWindowSeconds: 86_400,
      terminalSampleLimit: 10_000,
      terminalSampleTruncated: true,
      oldestQueuedAgeSeconds: 12.346,
      durationSeconds: { samples: 7, average: 1.235, p95: 2.346 }
    });
  });

  it("requeues a task on orderly worker shutdown without consuming an attempt", async () => {
    const database = fakePool((text, values) => {
      expect(text).toContain("GREATEST(0, attempt - 1)");
      expect(text).toContain("lease_token = NULL");
      expect(values).toEqual([JOB_ID, "lease-token"]);
      return { rowCount: 1 };
    });

    await expect(new ComputeJobRepository(database.pool).requeueForShutdown(JOB_ID, "lease-token")).resolves.toBe(true);
  });

  it("makes cancellation win atomically when a result or failure arrives", async () => {
    const statements: string[] = [];
    const database = fakePool((text) => {
      statements.push(text);
      return { rowCount: 1 };
    });
    const repository = new ComputeJobRepository(database.pool);

    await expect(repository.complete(JOB_ID, "lease-token", { ok: true })).resolves.toBe(true);
    await expect(repository.fail(JOB_ID, "lease-token", "worker_error", "boom")).resolves.toBe(true);

    expect(statements[0]).toContain("status = CASE WHEN cancel_requested_at IS NULL THEN 'completed' ELSE 'cancelled' END");
    expect(statements[0]).toContain("artifact_size_bytes = artifact_size_bytes");
    expect(statements[0]).not.toContain("status = 'running' AND cancel_requested_at IS NULL");
    expect(statements[1]).toContain("error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $3 END");
  });

  it("rejects an oversized result before the result write and terminally fails the job", async () => {
    const database = fakePool((text, values) => {
      expect(text).not.toContain("$3::jsonb");
      expect(values[2]).toBe("result_too_large");
      expect(String(values[3])).not.toContain("x".repeat(100));
      return { rowCount: 1 };
    });

    const completed = await new ComputeJobRepository(database.pool).complete(JOB_ID, "lease-token", { value: "x".repeat(MAX_COMPUTE_JOB_RESULT_BYTES + 1) });

    expect(completed).toBe(true);
    expect(database.queries).toHaveLength(1);
  });

  it("measures the serialized result in UTF-8 bytes", () => {
    const payload = { value: "€" };
    const serialized = JSON.stringify(payload);
    const utf8Bytes = Buffer.byteLength(serialized, "utf8");
    expect(utf8Bytes).toBeGreaterThan(serialized.length);

    expect(() => serializeComputeJobResult(payload, serialized.length)).toThrow(/byte limit/i);
    expect(serializeComputeJobResult(payload, utf8Bytes)).toBe(serialized);
  });

  it("fails non-serializable results without leaking result content", async () => {
    const circular: Record<string, unknown> = { marker: "must-not-leak" };
    circular.self = circular;
    const database = fakePool((_text, values) => {
      expect(values[2]).toBe("result_not_serializable");
      expect(String(values[3])).not.toContain("must-not-leak");
      return { rowCount: 1 };
    });

    await expect(new ComputeJobRepository(database.pool).complete(JOB_ID, "lease-token", circular)).resolves.toBe(true);
    expect(database.queries).toHaveLength(1);
  });

  it("requires an unexpired lease for every lease-owned operation", async () => {
    const statements: string[] = [];
    const database = fakePool((text) => {
      statements.push(text);
      if (text.startsWith("SELECT")) return { rows: [{ cancelled: false }] };
      return { rowCount: 1 };
    });
    const repository = new ComputeJobRepository(database.pool);

    await repository.heartbeat(JOB_ID, "lease-token", 30_000, 0.5);
    await repository.cancellationRequested(JOB_ID, "lease-token");
    await repository.complete(JOB_ID, "lease-token", { ok: true });
    await repository.fail(JOB_ID, "lease-token", "invalid_payload", "bad task");
    await repository.retryOrFail(JOB_ID, "lease-token", "worker_exit", "worker crashed");
    await repository.requeueForShutdown(JOB_ID, "lease-token");

    expect(statements).toHaveLength(6);
    for (const statement of statements) expect(statement).toContain("lease_expires_at > clock_timestamp()");
  });

  it("retries only within the attempt budget using capped exponential backoff", async () => {
    const database = fakePool((text, values) => {
      expect(text).toContain("WHEN attempt < max_attempts THEN 'queued' ELSE 'failed'");
      expect(text).toContain("LEAST(");
      expect(text).toContain("power(2::double precision");
      expect(text).toContain("lease_expires_at > clock_timestamp()");
      expect(values).toEqual([JOB_ID, "lease-token", "worker_exit", "worker crashed", 2_000, 60_000]);
      return { rowCount: 1 };
    });

    await expect(new ComputeJobRepository(database.pool).retryOrFail(JOB_ID, "lease-token", "worker_exit", "worker crashed")).resolves.toBe(true);
  });

  it("returns a claim acquired concurrently with shutdown before starting it", async () => {
    let releaseClaim!: (job: ClaimedJob) => void;
    const deferredClaim = new Promise<ClaimedJob>((resolve) => {
      releaseClaim = resolve;
    });
    const requeueForShutdown = vi.fn(async () => true);
    const repository = {
      claim: vi.fn(async () => deferredClaim),
      requeueForShutdown
    };
    let stopping = false;

    const pending = claimJobForExecution(repository, "worker-1", 30_000, () => stopping);
    stopping = true;
    releaseClaim(claimedJob());

    await expect(pending).resolves.toBeUndefined();
    expect(repository.claim).toHaveBeenCalledWith("worker-1", 30_000);
    expect(requeueForShutdown).toHaveBeenCalledWith(JOB_ID, "lease-token");
  });
});

describe("compute jobs HTTP boundary", () => {
  it("serves owner metrics before the UUID job route", async () => {
    const database = fakePool((text, values) => {
      expect(text.match(/owner_user_id = \$1/g)).toHaveLength(2);
      expect(values).toEqual([OWNER_ID]);
      return {
        rows: [
          {
            queue_depth: "1",
            running: "0",
            completed: "2",
            failed: "0",
            cancelled: "0",
            duration_samples: "2",
            oldest_queued_age_seconds: 5,
            average_duration_seconds: 1.5,
            p95_duration_seconds: 2,
            terminal_sample_truncated: false
          }
        ]
      };
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await fetch(`${base}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("vary")).toContain("Cookie");
      await expect(response.json()).resolves.toEqual({
        metrics: {
          queueDepth: 1,
          running: 0,
          completed: 2,
          failed: 0,
          cancelled: 0,
          terminalWindowSeconds: 86_400,
          terminalSampleLimit: 10_000,
          terminalSampleTruncated: false,
          oldestQueuedAgeSeconds: 5,
          durationSeconds: { samples: 2, average: 1.5, p95: 2 }
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  it("returns 410 with compact metadata after a job's artifacts expire", async () => {
    const database = fakePool((text) => {
      if (text.includes("WHERE owner_user_id = $1 AND id = $2")) {
        return {
          rows: [
            jobRow({
              status: "completed",
              payload: null,
              result: null,
              artifacts_pruned_at: new Date("2026-07-14T00:00:00.000Z")
            })
          ]
        };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await fetch(`${base}/${JOB_ID}`);
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      await expect(response.json()).resolves.toMatchObject({
        code: "job_artifacts_expired",
        job: {
          id: JOB_ID,
          status: "completed",
          artifactsExpired: true,
          artifactsPrunedAt: "2026-07-14T00:00:00.000Z"
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  it("rejects non-increasing candle timestamps before touching PostgreSQL", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const body = validBacktestBody();
      body.candles[5]!.time = body.candles[4]!.time;
      const response = await postJson(base, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("does not persist clientRequestId inside the executable worker payload", async () => {
    let insertedPayload: Record<string, unknown> | undefined;
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2") || text.includes("dedupe_key = $3")) return {};
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        insertedPayload = JSON.parse(String(values[3])) as Record<string, unknown>;
        expect(values[7]).toBe(Buffer.byteLength(String(values[3]), "utf8"));
        return {
          rows: [
            jobRow({
              id: values[0],
              payload: insertedPayload,
              estimated_cost: String(values[4]),
              client_request_id: values[5],
              dedupe_key: values[6]
            })
          ]
        };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await postJson(base, validBacktestBody(), { "x-request-id": "do-not-reflect-this-secret" });
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("vary")).toContain("Cookie");
      const body = (await response.json()) as { job: { id: string } };
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(requestId).not.toBe("do-not-reflect-this-secret");
      expect(response.headers.get("x-job-id")).toBe(body.job.id);
      expect(insertedPayload).toMatchObject({ kind: "backtest" });
      expect(insertedPayload).not.toHaveProperty("clientRequestId");
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain(requestId);
      expect(logged).toContain(body.job.id);
      expect(logged).not.toContain("do-not-reflect-this-secret");
      expect(logged).not.toContain("request-0001");
    } finally {
      log.mockRestore();
      await closeServer(server);
    }
  });

  it("returns 410 for an exact client-request retry while keeping a tombstone idempotent", async () => {
    let stored: ReturnType<typeof jobRow> | undefined;
    let insertCount = 0;
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2")) return stored ? { rows: [stored] } : {};
      if (text.includes("dedupe_key = $3")) return {};
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        insertCount += 1;
        stored = jobRow({
          id: values[0],
          payload: JSON.parse(String(values[3])),
          estimated_cost: String(values[4]),
          client_request_id: values[5],
          dedupe_key: values[6]
        });
        return { rows: [stored] };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect((await postJson(base, validBacktestBody())).status).toBe(202);
      stored = jobRow({
        ...stored,
        status: "completed",
        payload: null,
        result: null,
        completed_at: new Date("2026-07-14T00:00:00.000Z"),
        artifacts_pruned_at: new Date("2026-07-15T00:00:00.000Z")
      });
      const retry = await postJson(base, validBacktestBody());
      expect(retry.status).toBe(410);
      await expect(retry.json()).resolves.toMatchObject({
        code: "job_artifacts_expired",
        job: { artifactsExpired: true }
      });
      expect(insertCount).toBe(1);
    } finally {
      log.mockRestore();
      await closeServer(server);
    }
  });
});

describe("backtest worker protocol", () => {
  it("rejects malformed and oversized task payloads before execution", () => {
    expect(() => parseBacktestTask({})).toThrow(/invalid backtest task/i);
    expect(() => parseBacktestTask({ strategy: {}, config: {}, candles: [] })).toThrow(/candle count/i);
    expect(() => parseBacktestTask({ strategy: {}, config: {}, candles: Array.from({ length: 20_001 }) })).toThrow(/candle count/i);
  });

  it("bounds every high-cardinality report collection and preserves sampled endpoints", () => {
    const equityCurve = Array.from({ length: 2_001 }, (_, time) => ({ time, equity: time }));
    const report = {
      schemaVersion: 1,
      name: "large report",
      metrics: {},
      tested: {},
      metadata: {},
      provenance: {},
      trades: Array.from({ length: 5_001 }, () => ({})),
      equityCurve,
      warnings: Array.from({ length: 501 }, () => ({})),
      alerts: Array.from({ length: 501 }, () => ({})),
      signals: Array.from({ length: 2_001 }, () => ({}))
    } as unknown as BacktestResult;

    const compact = compactBacktestReport(report);

    expect(compact.trades).toHaveLength(5_000);
    expect(compact.equityCurve).toHaveLength(2_000);
    expect((compact.equityCurve as typeof equityCurve)[0]).toEqual(equityCurve[0]);
    expect((compact.equityCurve as typeof equityCurve).at(-1)).toEqual(equityCurve.at(-1));
    expect(compact.warnings).toHaveLength(500);
    expect(compact.alerts).toHaveLength(500);
    expect(compact.signals).toHaveLength(2_000);
    expect(compact).toMatchObject({
      tradesTruncated: true,
      equityCurveSampled: true,
      warningsTruncated: true,
      alertsTruncated: true,
      signalsTruncated: true
    });
  });
});

function validBacktestBody() {
  return {
    kind: "backtest" as const,
    strategy: {
      name: "Always long",
      inputs: [],
      body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }]
    },
    candles: Array.from({ length: 10 }, (_, index) => ({
      time: 1_700_000_000_000 + index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000
    })),
    config: {
      initialCapital: 10_000,
      commissionPct: 0.05,
      slippagePct: 0.02,
      allowShort: true
    },
    clientRequestId: "request-0001"
  };
}

function claimedJob(): ClaimedJob {
  return {
    id: JOB_ID,
    ownerUserId: OWNER_ID,
    jobType: "backtest",
    status: "running",
    payload: { kind: "backtest" },
    leaseToken: "lease-token",
    progress: 0,
    estimatedCost: 10,
    attempt: 1,
    maxAttempts: 2,
    artifactsExpired: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

async function startJobsApi(pool: Pool): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.authPrincipal = { user: { id: OWNER_ID } };
    next();
  });
  app.use("/api/jobs", createComputeJobsRouter(pool));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}/api/jobs` };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
