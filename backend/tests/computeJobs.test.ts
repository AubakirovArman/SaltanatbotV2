import express from "express";
import type { Server } from "node:http";
import type { BacktestResult } from "@saltanatbotv2/backtest-core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  ComputeJobRepository,
  JobIdempotencyConflictError
} from "../src/jobs/repository.js";
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
    updated_at: now,
    lease_token: null,
    client_request_id: null,
    dedupe_key: "same-job",
    ...overrides
  };
}

function fakePool(
  responder: (text: string, values: readonly unknown[]) => { rows?: unknown[]; rowCount?: number }
): { pool: Pool; queries: RecordedQuery[] } {
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
    const database = fakePool((text) => text.includes("client_request_id = $2") ? { rows: [existing] } : {});

    await expect(new ComputeJobRepository(database.pool).enqueue({
      ownerUserId: OWNER_ID,
      jobType: "backtest",
      payload: { kind: "backtest" },
      estimatedCost: 10,
      clientRequestId: "request-0001",
      dedupeKey: "new-content"
    })).rejects.toBeInstanceOf(JobIdempotencyConflictError);

    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(database.queries.some((query) => query.text.includes("INSERT INTO compute_jobs"))).toBe(false);
  });

  it("uses owner advisory locking and rechecks the one-running-job invariant when claiming", async () => {
    const database = fakePool((text, values) => {
      if (text.includes("UPDATE compute_jobs j SET")) {
        expect(text).toContain("pg_try_advisory_xact_lock");
        expect(text.match(/active\.status = 'running'/g)).toHaveLength(2);
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
      return { rows: [jobRow({ payload: null, result: null })] };
    });

    const jobs = await new ComputeJobRepository(database.pool).list(OWNER_ID, 10_000);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty("payload");
    expect(jobs[0]).not.toHaveProperty("result");
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
    expect(statements[0]).not.toContain("status = 'running' AND cancel_requested_at IS NULL");
    expect(statements[1]).toContain("error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $3 END");
  });
});

describe("compute jobs HTTP boundary", () => {
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
        return {
          rows: [jobRow({
            id: values[0],
            payload: insertedPayload,
            estimated_cost: String(values[4]),
            client_request_id: values[5],
            dedupe_key: values[6]
          })]
        };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, validBacktestBody());
      expect(response.status).toBe(202);
      expect(insertedPayload).toMatchObject({ kind: "backtest" });
      expect(insertedPayload).not.toHaveProperty("clientRequestId");
    } finally {
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

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
