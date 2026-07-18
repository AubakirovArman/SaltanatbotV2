import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputeJobsRouter } from "../src/jobs/routes.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000096";
const JOB_ID = "00000000-0000-4000-8000-000000000097";

let log: ReturnType<typeof vi.spyOn>;

describe("multi-market evaluation through the compute jobs HTTP boundary", () => {
  beforeEach(() => {
    log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it("enqueues a multi-market-eval job with the durable spec payload and bars×markets cost", async () => {
    let insertValues: readonly unknown[] | undefined;
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2")) return {};
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        insertValues = values;
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
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, validEvaluationBody());
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      const body = (await response.json()) as { job: { id: string; jobType: string } };
      expect(response.headers.get("x-job-id")).toBe(body.job.id);
      expect(body.job.jobType).toBe("multi-market-eval");

      expect(insertValues?.[2]).toBe("multi-market-eval");
      expect(insertValues?.[4]).toBe(1_000 * 2);
      expect(insertValues?.[5]).toBe("eval-request-0001");
      expect(insertValues?.[6]).toMatch(/^[0-9a-f]{64}$/);
      const payload = JSON.parse(String(insertValues?.[3])) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["kind", "lookbackBars", "markets", "seed", "split", "strategy"]);
      expect(payload).toMatchObject({
        kind: "multi-market-eval",
        strategy: { name: "Always long" },
        markets: [
          { symbol: "BTCUSDT", timeframe: "1h" },
          { symbol: "ETHUSDT", timeframe: "1h" }
        ],
        lookbackBars: 1_000,
        // Split defaults resolve at the HTTP boundary, before the durable payload.
        split: { trainFraction: 0.7, embargoBars: 8 },
        seed: 7
      });
      expect(payload).not.toHaveProperty("clientRequestId");
      expect(payload).not.toHaveProperty("ir");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects markets that are unknown or lack real exchange data before touching PostgreSQL", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      for (const symbol of ["NOPEUSDT", "EURUSD"]) {
        const body = validEvaluationBody();
        body.markets = [{ symbol, timeframe: "1h" }];
        const response = await postJson(base, body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: `Market ${symbol} is not available for server evaluation.`,
          code: "unknown_market"
        });
      }
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects an invalid strategy IR with the invalid_strategy code", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, { ...validEvaluationBody(), ir: { name: "bad", inputs: [], body: [{ k: "nope" }] } });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; code: string };
      expect(body.code).toBe("invalid_strategy");
      expect(body.error).toMatch(/^Invalid strategy: /);
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects bound violations and unknown fields as invalid_request before touching PostgreSQL", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const valid = validEvaluationBody();
      const sevenMarkets = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"].map((symbol) => ({
        symbol,
        timeframe: "1h"
      }));
      const invalidBodies: unknown[] = [
        { kind: "multi-market-eval" },
        { ...valid, extra: true },
        { ...valid, markets: [] },
        { ...valid, markets: sevenMarkets },
        { ...valid, markets: [valid.markets[0], valid.markets[0]] },
        { ...valid, markets: [{ symbol: "BTCUSDT", timeframe: "1h" }, { symbol: "ETHUSDT", timeframe: "4h" }] },
        { ...valid, markets: [{ symbol: "BTCUSDT", timeframe: "13h" }] },
        { ...valid, lookbackBars: 499 },
        { ...valid, lookbackBars: 20_001 },
        { ...valid, split: { trainFraction: 0.45, embargoBars: 8 } },
        { ...valid, split: { trainFraction: 0.95, embargoBars: 8 } },
        { ...valid, split: { trainFraction: 0.7, embargoBars: 501 } },
        { ...valid, split: { trainFraction: 0.7, embargoBars: 8, extra: 1 } },
        { ...valid, seed: -1 },
        { ...valid, seed: 1.5 },
        (({ seed: _seed, ...rest }) => rest)(valid),
        { ...valid, clientRequestId: "short" }
      ];
      for (const body of invalidBodies) {
        const response = await postJson(base, body);
        expect(response.status, JSON.stringify(body).slice(0, 120)).toBe(400);
        const parsed = (await response.json()) as { code: string };
        expect(parsed.code).toBe("invalid_request");
      }
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("keeps rejecting unknown job kinds exactly as before the registry existed", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, { kind: "orderbook-ml", payload: {} });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; code: string; details: { fieldErrors: Record<string, unknown> } };
      // Unknown kinds still fall through to the backtest schema's literal check.
      expect(body.error).toBe("Invalid research job.");
      expect(body.code).toBe("invalid_request");
      expect(body.details.fieldErrors).toHaveProperty("kind");
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

function validEvaluationBody() {
  return {
    kind: "multi-market-eval" as const,
    ir: {
      name: "Always long",
      inputs: [],
      body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }]
    },
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h" },
      { symbol: "ETHUSDT", timeframe: "1h" }
    ] as { symbol: string; timeframe: string }[],
    lookbackBars: 1_000,
    seed: 7,
    clientRequestId: "eval-request-0001"
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: JOB_ID,
    owner_user_id: OWNER_ID,
    job_type: "multi-market-eval",
    status: "queued",
    payload: { kind: "multi-market-eval" },
    result: null,
    error_code: null,
    error_message: null,
    progress: 0,
    estimated_cost: "2000",
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

function fakePool(responder: (text: string, values: readonly unknown[]) => { rows?: unknown[]; rowCount?: number }): { pool: Pool } {
  const query = async (text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 };
    }
    const result = responder(text, values);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
  };
  const client = { query, release() {} };
  return { pool: { query, connect: async () => client } as unknown as Pool };
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
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
