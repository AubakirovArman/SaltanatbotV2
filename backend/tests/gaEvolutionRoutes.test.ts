import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGaEvolutionRouter } from "../src/ga/routes.js";
import { createComputeJobsRouter } from "../src/jobs/routes.js";
import { MemoryGaLineageStore } from "./support/gaLineageStoreMemory.js";

const OWNER_A = "00000000-0000-4000-8000-000000000211";
const OWNER_B = "00000000-0000-4000-8000-000000000212";
const JOB_ID = "00000000-0000-4000-8000-000000000213";
const RUN_A = "00000000-0000-4000-8000-000000000214";
const RUN_B = "00000000-0000-4000-8000-000000000215";
const SEED_FP = "strategy-v1-aaaaaaaaaaaaaaaa-100";
const OVERFIT_FP = "strategy-v1-bbbbbbbbbbbbbbbb-200";
const CHILD_FP = "strategy-v1-cccccccccccccccc-300";
const NO_OOS_FP = "strategy-v1-dddddddddddddddd-400";
const PROMOTED_AT = 1_752_800_000_000;

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

function validStartBody(): Record<string, unknown> {
  return {
    kind: "ga-evolution",
    mode: "start",
    config: {
      markets: ["BTCUSDT", "ETHUSDT"],
      timeframe: "1h",
      lookbackBars: 500,
      seed: 1_234,
      population: 8,
      generations: 2
    },
    clientRequestId: "ga-request-0001"
  };
}

describe("ga-evolution through the compute jobs HTTP boundary", () => {
  it("enqueues a start job with resolved defaults and bars x markets x generations cost", async () => {
    let insertValues: readonly unknown[] | undefined;
    const database = fakePool((text, values) => {
      if (text.includes("client_request_id = $2")) return {};
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("UPDATE ga_runs")) return { rowCount: 0 };
      if (text.includes("AS active")) return { rows: [{ active: false }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        insertValues = values;
        return { rows: [jobRow({ id: values[0], payload: JSON.parse(String(values[3])) })] };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, validStartBody());
      expect(response.status).toBe(202);
      const body = (await response.json()) as { job: { id: string; jobType: string } };
      expect(body.job.jobType).toBe("ga-evolution");

      expect(insertValues?.[2]).toBe("ga-evolution");
      expect(insertValues?.[4]).toBe(500 * 2 * 2);
      expect(insertValues?.[5]).toBe("ga-request-0001");
      expect(insertValues?.[6]).toMatch(/^[0-9a-f]{64}$/);
      const payload = JSON.parse(String(insertValues?.[3])) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["config", "kind", "mode"]);
      // Defaults (split, objectives) resolve at the HTTP boundary, before the
      // durable payload — the executor re-validates the same resolved shape.
      expect(payload).toEqual({
        kind: "ga-evolution",
        mode: "start",
        config: {
          markets: ["BTCUSDT", "ETHUSDT"],
          timeframe: "1h",
          lookbackBars: 500,
          split: { trainFraction: 0.7, embargoBars: 8 },
          seed: 1_234,
          population: 8,
          generations: 2,
          objectives: ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"]
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  it("enqueues a resume job for a checkpointed run with the flat resume cost", async () => {
    let insertValues: readonly unknown[] | undefined;
    const database = fakePool((text, values) => {
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("UPDATE ga_runs")) return { rowCount: 0 };
      if (text.includes("AS active")) return { rows: [{ active: false }] };
      if (text.includes("FROM ga_runs WHERE owner_user_id")) return { rows: [gaRunRow({ status: "checkpointed" })] };
      if (text.includes("INSERT INTO compute_jobs")) {
        insertValues = values;
        return { rows: [jobRow({ id: values[0], payload: JSON.parse(String(values[3])) })] };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, { kind: "ga-evolution", mode: "resume", runId: RUN_A });
      expect(response.status).toBe(202);
      expect(JSON.parse(String(insertValues?.[3]))).toEqual({ kind: "ga-evolution", mode: "resume", runId: RUN_A });
      expect(insertValues?.[4]).toBe(10_000);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a second run while one is active (429 ga_run_active) without enqueuing", async () => {
    let inserted = false;
    const database = fakePool((text) => {
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("UPDATE ga_runs")) return { rowCount: 0 };
      if (text.includes("AS active")) return { rows: [{ active: true }] };
      if (text.includes("INSERT INTO compute_jobs")) {
        inserted = true;
        return {};
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const response = await postJson(base, validStartBody());
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ code: "ga_run_active" });
      expect(inserted).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects resumes of missing and non-checkpointed runs with explicit codes", async () => {
    let runStatus: string | undefined;
    const database = fakePool((text) => {
      if (text.includes("count(*)")) return { rows: [{ active: "0" }] };
      if (text.includes("UPDATE ga_runs")) return { rowCount: 0 };
      if (text.includes("AS active")) return { rows: [{ active: false }] };
      if (text.includes("FROM ga_runs WHERE owner_user_id")) {
        return runStatus ? { rows: [gaRunRow({ status: runStatus })] } : { rows: [] };
      }
      return {};
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      const missing = await postJson(base, { kind: "ga-evolution", mode: "resume", runId: RUN_A });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ code: "ga_run_not_found" });

      runStatus = "completed";
      const terminal = await postJson(base, { kind: "ga-evolution", mode: "resume", runId: RUN_A });
      expect(terminal.status).toBe(409);
      await expect(terminal.json()).resolves.toMatchObject({ code: "ga_run_not_resumable" });
    } finally {
      await closeServer(server);
    }
  });

  it("rejects unknown markets and bound violations before touching PostgreSQL", async () => {
    let touched = false;
    const database = fakePool(() => {
      touched = true;
      throw new Error("database must not be touched");
    });
    const { server, base } = await startJobsApi(database.pool);
    try {
      for (const symbol of ["NOPEUSDT", "EURUSD"]) {
        const body = validStartBody();
        (body.config as Record<string, unknown>).markets = [symbol];
        const response = await postJson(base, body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: `Market ${symbol} is not available for server evolution.`,
          code: "unknown_market"
        });
      }

      const config = (overrides: Record<string, unknown>) => ({ ...validStartBody(), config: { ...validStartBody().config as Record<string, unknown>, ...overrides } });
      const invalidBodies: unknown[] = [
        { kind: "ga-evolution" },
        { kind: "ga-evolution", mode: "start" },
        { ...validStartBody(), extra: true },
        config({ markets: [] }),
        config({ markets: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"] }),
        config({ markets: ["BTCUSDT", "BTCUSDT"] }),
        config({ timeframe: "13h" }),
        config({ lookbackBars: 499 }),
        config({ lookbackBars: 20_001 }),
        config({ split: { trainFraction: 0.45, embargoBars: 8 } }),
        config({ split: { trainFraction: 0.7, embargoBars: 501 } }),
        config({ seed: -1 }),
        config({ seed: 4_294_967_296 }),
        config({ population: 7 }),
        config({ population: 65 }),
        config({ generations: 0 }),
        config({ generations: 17 }),
        config({ objectives: ["netProfitPct"] }),
        config({ objectives: ["netProfitPct", "netProfitPct"] }),
        config({ objectives: ["netProfitPct", "winRate"] }),
        { kind: "ga-evolution", mode: "resume", runId: "not-a-uuid" },
        { kind: "ga-evolution", mode: "resume" }
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
});

describe("owner-scoped GA read and promotion routes", () => {
  let store: MemoryGaLineageStore;
  let server: Server;
  let base: string;
  let actor: string;
  let promotionClock: number;

  beforeEach(async () => {
    store = new MemoryGaLineageStore();
    actor = OWNER_A;
    promotionClock = PROMOTED_AT;
    seedStore(store);
    const app = express();
    app.use((_request, response, next) => {
      response.locals.authPrincipal = { user: { id: actor } };
      next();
    });
    app.use("/api/ga", createGaEvolutionRouter({} as Pool, { repository: store, now: () => promotionClock }));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ga`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("lists only the caller's runs and never leaks the checkpoint", async () => {
    const response = await fetch(`${base}/runs`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const body = (await response.json()) as { runs: Record<string, unknown>[] };
    expect(body.runs.map((run) => run.id)).toEqual([RUN_A]);
    expect(body.runs[0]).toMatchObject({ status: "completed", seed: 1_234, currentGeneration: 2, engineVersion: "backtest-core-v1" });
    expect(body.runs[0]).not.toHaveProperty("checkpoint");
    expect(body.runs[0]).not.toHaveProperty("ownerUserId");

    actor = OWNER_B;
    const other = await fetch(`${base}/runs`);
    expect(((await other.json()) as { runs: unknown[] }).runs).toEqual([expect.objectContaining({ id: RUN_B })]);
  });

  it("serves run detail with frontier summary and a bounded, filterable candidate page", async () => {
    const detail = (await (await fetch(`${base}/runs/${RUN_A}`)).json()) as {
      run: Record<string, unknown>;
      frontier: Record<string, unknown>;
      candidates: Record<string, unknown>[];
    };
    expect(detail.run).toMatchObject({ id: RUN_A, status: "completed" });
    expect(detail.frontier).toMatchObject({ schemaVersion: "ga-pareto-v1", generation: 2 });
    // Ordered (generation ASC, fingerprint ASC); summaries carry no IR/metrics.
    expect(detail.candidates.map((candidate) => candidate.fingerprint)).toEqual([SEED_FP, OVERFIT_FP, NO_OOS_FP, CHILD_FP]);
    expect(detail.candidates[0]).toMatchObject({ paretoRank: 0, promotedAt: null });
    expect(detail.candidates[0]).not.toHaveProperty("ir");
    expect(detail.candidates[2]!.oosReport).toBeNull();

    const filtered = (await (await fetch(`${base}/runs/${RUN_A}?generation=2&limit=1`)).json()) as { candidates: Record<string, unknown>[] };
    expect(filtered.candidates.map((candidate) => candidate.fingerprint)).toEqual([CHILD_FP]);

    // Owner scoping is a 404, never a hint that the run exists.
    const crossOwner = await fetch(`${base}/runs/${RUN_B}`);
    expect(crossOwner.status).toBe(404);
    await expect(crossOwner.json()).resolves.toMatchObject({ code: "ga_run_not_found" });
    expect((await fetch(`${base}/runs/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${base}/runs/${RUN_A}?limit=0`)).status).toBe(400);
  });

  it("serves candidate evidence with the lineage chain and explicit 404 codes", async () => {
    const detail = (await (await fetch(`${base}/runs/${RUN_A}/candidates/${CHILD_FP}`)).json()) as { candidate: Record<string, unknown> };
    expect(detail.candidate).toMatchObject({
      fingerprint: CHILD_FP,
      generation: 2,
      paretoRank: 0,
      parentFingerprints: [SEED_FP],
      mutationLog: [{ field: "signal.period", from: 14, to: 21 }]
    });
    expect(detail.candidate.ir).toEqual({ name: "GA child", inputs: [], body: [] });
    expect(detail.candidate.metrics).toMatchObject({ markets: [expect.objectContaining({ symbol: "BTCUSDT" })] });
    // Ancestor chain, closest parents first; seeds terminate the walk.
    expect(detail.candidate.lineage).toEqual([
      { fingerprint: SEED_FP, generation: 1, parentFingerprints: [], mutationLog: [] }
    ]);

    const unknown = await fetch(`${base}/runs/${RUN_A}/candidates/strategy-v1-ffffffffffffffff-1`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ code: "ga_candidate_not_found" });
    const missingRun = await fetch(`${base}/runs/${RUN_B}/candidates/${CHILD_FP}`);
    expect(missingRun.status).toBe(404);
    await expect(missingRun.json()).resolves.toMatchObject({ code: "ga_run_not_found" });
    expect((await fetch(`${base}/runs/${RUN_A}/candidates/${encodeURIComponent("..%2Fetc")}`)).status).toBe(400);
  });

  it("refuses promotion without a clean out-of-sample report", async () => {
    const noOos = await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: NO_OOS_FP });
    expect(noOos.status).toBe(409);
    await expect(noOos.json()).resolves.toMatchObject({ code: "ga_promotion_requires_oos" });

    const overfit = await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: OVERFIT_FP });
    expect(overfit.status).toBe(409);
    await expect(overfit.json()).resolves.toMatchObject({ code: "ga_promotion_overfit" });

    // Neither refusal stamped anything.
    expect(store.allCandidateRows().every((row) => row.promotedAt === undefined)).toBe(true);

    actor = OWNER_B;
    const crossOwner = await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: SEED_FP });
    expect(crossOwner.status).toBe(404);
    await expect(crossOwner.json()).resolves.toMatchObject({ code: "ga_run_not_found" });
  });

  it("promotes a clean candidate returning the full provenance bundle and stamps promoted_at idempotently", async () => {
    const response = await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: CHILD_FP });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifact: Record<string, unknown> };
    expect(body.artifact).toEqual({
      schemaVersion: "ga-artifact-v1",
      ir: { name: "GA child", inputs: [], body: [] },
      provenance: {
        runId: RUN_A,
        fingerprint: CHILD_FP,
        generation: 2,
        seed: 1_234,
        datasetFingerprint: "e".repeat(64),
        engineVersion: "backtest-core-v1",
        generatorVersion: "bounded-grammar-v1",
        objectives: { netProfitPct: 8, maxDrawdownPct: 3, sharpe: 1.2, complexity: 300 },
        paretoRank: 0,
        oosReport: cleanOosReport(),
        lineage: [{ fingerprint: SEED_FP, generation: 1, parentFingerprints: [], mutationLog: [] }],
        promotedAt: PROMOTED_AT
      }
    });

    // Idempotent: a later promotion keeps the first promoted_at stamp.
    promotionClock = PROMOTED_AT + 60_000;
    const replay = await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: CHILD_FP });
    const replayBody = (await replay.json()) as { artifact: { provenance: { promotedAt: number } } };
    expect(replayBody.artifact.provenance.promotedAt).toBe(PROMOTED_AT);

    expect((await postJson(`${base}/promote`, { runId: RUN_A, fingerprint: CHILD_FP, extra: 1 })).status).toBe(400);
  });
});

function cleanOosReport(): Record<string, unknown> {
  return { gapPct: { netProfitPct: 2.5 }, oosLossShare: 0, dispersion: 1.5, flags: { overfit: false, unstable: false } };
}

function overfitOosReport(): Record<string, unknown> {
  return { gapPct: { netProfitPct: 40 }, oosLossShare: 0.5, dispersion: 12, flags: { overfit: true, unstable: false } };
}

function seedStore(store: MemoryGaLineageStore): void {
  for (const [runId, ownerUserId] of [[RUN_A, OWNER_A], [RUN_B, OWNER_B]] as const) {
    store.seedRun({
      id: runId,
      ownerUserId,
      jobId: JOB_ID,
      status: "completed",
      config: { markets: ["BTCUSDT"], timeframe: "1h", generations: 2, population: 8, seed: 1_234 },
      seed: 1_234,
      datasetFingerprint: "e".repeat(64),
      engineVersion: "backtest-core-v1",
      generatorVersion: "bounded-grammar-v1",
      currentGeneration: 2,
      checkpoint: { schemaVersion: "ga-checkpoint-v1" },
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    });
  }
  const candidate = (fingerprint: string, generation: number, objectives: Record<string, number>, oosReport: Record<string, unknown>, parents: string[] = [], mutationLog: unknown[] = []) => ({
    fingerprint,
    generation,
    parentFingerprints: parents,
    mutationLog,
    ir: { name: fingerprint === CHILD_FP ? "GA child" : "GA seed", inputs: [], body: [] },
    metrics: { markets: [{ symbol: "BTCUSDT", train: { netProfitPct: 10 }, outOfSample: { netProfitPct: 8 } }] },
    objectives,
    oosReport
  });
  void store.recordGeneration(RUN_A, {
    generation: 1,
    candidates: [
      candidate(SEED_FP, 1, { netProfitPct: 9, maxDrawdownPct: 4, sharpe: 1.1, complexity: 100 }, cleanOosReport()),
      candidate(OVERFIT_FP, 1, { netProfitPct: 11, maxDrawdownPct: 5, sharpe: 1.3, complexity: 200 }, overfitOosReport())
    ],
    paretoRanks: new Map([[SEED_FP, 0], [OVERFIT_FP, 1]]),
    pareto: { schemaVersion: "ga-pareto-v1", generation: 1, totalCandidates: 2, frontier: [] },
    checkpoint: { schemaVersion: "ga-checkpoint-v1" }
  });
  void store.recordGeneration(RUN_A, {
    generation: 2,
    candidates: [
      candidate(CHILD_FP, 2, { netProfitPct: 8, maxDrawdownPct: 3, sharpe: 1.2, complexity: 300 }, cleanOosReport(), [SEED_FP], [{ field: "signal.period", from: 14, to: 21 }])
    ],
    paretoRanks: new Map([[SEED_FP, 0], [OVERFIT_FP, 1], [CHILD_FP, 0]]),
    pareto: { schemaVersion: "ga-pareto-v1", generation: 2, totalCandidates: 3, frontier: [] },
    checkpoint: { schemaVersion: "ga-checkpoint-v1" }
  });
  // A stored row without out-of-sample evidence (mirrors oos_report NULL).
  store.seedCandidate({
    runId: RUN_A,
    fingerprint: NO_OOS_FP,
    generation: 1,
    parentFingerprints: [],
    mutationLog: [],
    ir: { name: "GA missing oos", inputs: [], body: [] },
    metrics: { markets: [] },
    objectives: { netProfitPct: 1, maxDrawdownPct: 1, sharpe: 0.1, complexity: 400 },
    createdAt: "2026-07-18T00:00:00.000Z"
  });
}

function gaRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: RUN_A,
    owner_user_id: OWNER_A,
    job_id: JOB_ID,
    status: "checkpointed",
    config: { markets: ["BTCUSDT"], timeframe: "1h" },
    seed: "1234",
    dataset_fingerprint: "e".repeat(64),
    engine_version: "backtest-core-v1",
    generator_version: "bounded-grammar-v1",
    current_generation: 1,
    checkpoint: null,
    pareto: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: JOB_ID,
    owner_user_id: OWNER_A,
    job_type: "ga-evolution",
    status: "queued",
    payload: { kind: "ga-evolution" },
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
    response.locals.authPrincipal = { user: { id: OWNER_A } };
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
