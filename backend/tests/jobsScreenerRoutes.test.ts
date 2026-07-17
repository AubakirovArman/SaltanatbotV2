import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1 } from "@saltanatbotv2/contracts";
import { createComputeJobsRouter } from "../src/jobs/routes.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000081";
const JOB_ID = "00000000-0000-4000-8000-000000000082";
const PRESET_ID = "00000000-0000-4000-8000-000000000083";

const definition = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Jobs screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 50,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [{ kind: "rsi", period: 14, condition: "above", value: "55" }],
  researchOnly: true,
  executionPermission: false
};

let log: ReturnType<typeof vi.spyOn>;

describe("screener runs through the compute jobs HTTP boundary", () => {
  beforeEach(() => {
    log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it("enqueues a screener job with a bounded payload and the universe as its cost", async () => {
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
      const response = await postJson(base, validScreenerBody());
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      const body = (await response.json()) as { job: { id: string; jobType: string } };
      expect(response.headers.get("x-job-id")).toBe(body.job.id);
      expect(body.job.jobType).toBe("screener");

      expect(insertValues?.[2]).toBe("screener");
      expect(insertValues?.[4]).toBe(definition.universeLimit);
      expect(insertValues?.[5]).toBe("screener-request-0001");
      expect(insertValues?.[6]).toMatch(/^[0-9a-f]{64}$/);
      const payload = JSON.parse(String(insertValues?.[3])) as Record<string, unknown>;
      expect(payload).toMatchObject({
        kind: "screener",
        request: {
          schemaVersion: "screener-run-request-v1",
          definition: { name: "Jobs screen", universeLimit: 50 },
          researchOnly: true,
          executionPermission: false
        }
      });
      // The idempotency key stays on its own column, never inside the payload.
      expect(payload).not.toHaveProperty("clientRequestId");
    } finally {
      await closeServer(server);
    }
  });

  it("charges preset runs at the maximum universe cost until the worker resolves them", async () => {
    let estimatedCost: unknown;
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2")) return {};
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        estimatedCost = values[4];
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
      const response = await postJson(base, {
        kind: "screener",
        clientRequestId: "screener-request-0002",
        request: {
          schemaVersion: "screener-run-request-v1",
          presetId: PRESET_ID,
          researchOnly: true,
          executionPermission: false
        }
      });
      expect(response.status).toBe(202);
      expect(estimatedCost).toBe(SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects invalid screener job envelopes before touching PostgreSQL", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const valid = validScreenerBody();
      const invalidBodies: unknown[] = [
        { kind: "screener" },
        { ...valid, clientRequestId: "short" },
        { ...valid, extra: true },
        {
          ...valid,
          request: { ...valid.request, presetId: PRESET_ID }
        },
        {
          ...valid,
          request: { ...valid.request, definition: { ...definition, executionPermission: true } }
        }
      ];
      for (const body of invalidBodies) {
        const response = await postJson(base, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Invalid screener job.", code: "invalid_request" });
      }
      expect(touched).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

function validScreenerBody() {
  return {
    kind: "screener" as const,
    clientRequestId: "screener-request-0001",
    request: {
      schemaVersion: "screener-run-request-v1",
      definition,
      researchOnly: true,
      executionPermission: false
    }
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-17T00:00:00.000Z");
  return {
    id: JOB_ID,
    owner_user_id: OWNER_ID,
    job_type: "screener",
    status: "queued",
    payload: { kind: "screener" },
    result: null,
    error_code: null,
    error_message: null,
    progress: 0,
    estimated_cost: "50",
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
