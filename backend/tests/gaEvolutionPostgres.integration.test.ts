import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { LATEST_DATABASE_SCHEMA_VERSION } from "../src/database/schema.js";
import {
  GaEvolutionRepository,
  GaPromotionOverfitError,
  GaPromotionRequiresOosError,
  GaRunActiveError,
  type GaNewCandidateInput
} from "../src/ga/repository.js";
import { ComputeJobRepository } from "../src/jobs/repository.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.GA_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000221";
const OWNER_B = "00000000-0000-4000-8000-000000000222";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const CLEAN_FP = "strategy-v1-aaaaaaaaaaaaaaaa-100";
const OVERFIT_FP = "strategy-v1-bbbbbbbbbbbbbbbb-200";
let pool: Pool;
let repository: GaEvolutionRepository;
let jobs: ComputeJobRepository;

describePostgres("GA evolution lineage against isolated PostgreSQL (schema v17)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "GA_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'ga-owner-a', 'ga-owner-a', $3, 'active'),
              ($2, 'ga-owner-b', 'ga-owner-b', $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, PASSWORD_HASH]
    );
    repository = new GaEvolutionRepository(pool);
    jobs = new ComputeJobRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ga_candidates, ga_runs CASCADE");
    await pool.query("TRUNCATE compute_jobs, compute_job_retention_usage CASCADE");
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("TRUNCATE ga_candidates, ga_runs CASCADE").catch(() => undefined);
    await pool.end();
  });

  it("migrates to schema v17 with the GA tables and indexes installed", async () => {
    const applied = await pool.query<{ version: number }>("SELECT max(version)::integer AS version FROM schema_migrations");
    expect(applied.rows[0]?.version).toBe(LATEST_DATABASE_SCHEMA_VERSION);
    expect(applied.rows[0]?.version).toBe(18);
    const objects = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('public.ga_runs')::text AS runs_table,
         to_regclass('public.ga_candidates')::text AS candidates_table,
         to_regclass('public.ga_runs_owner_recent_index')::text AS owner_index,
         to_regclass('public.ga_runs_one_active_per_owner')::text AS active_index,
         to_regclass('public.ga_candidates_run_generation_index')::text AS generation_index`
    );
    expect(objects.rows[0]).toEqual({
      runs_table: "ga_runs",
      candidates_table: "ga_candidates",
      owner_index: "ga_runs_owner_recent_index",
      active_index: "ga_runs_one_active_per_owner",
      generation_index: "ga_candidates_run_generation_index"
    });
  });

  it("enforces one active run per owner and the atomic checkpointed->running resume claim", async () => {
    const first = await createRun(OWNER_A);
    await expect(createRun(OWNER_A)).rejects.toBeInstanceOf(GaRunActiveError);
    // Another owner keeps an independent capacity.
    const other = await createRun(OWNER_B);
    expect(other.ownerUserId).toBe(OWNER_B);

    await repository.finishRun(first.id, { status: "checkpointed", checkpoint: { schemaVersion: "ga-checkpoint-v1" } });
    const second = await createRun(OWNER_A);

    // A checkpointed run cannot be claimed while another run is active ...
    await expect(repository.claimResume(OWNER_A, first.id, second.jobId!)).rejects.toBeInstanceOf(GaRunActiveError);
    await repository.finishRun(second.id, { status: "cancelled" });

    // ... and exactly one resume claim wins once capacity is free.
    const resumeJob = await enqueueJob(OWNER_A);
    const claimed = await repository.claimResume(OWNER_A, first.id, resumeJob.id);
    expect(claimed).toMatchObject({ id: first.id, status: "running", jobId: resumeJob.id });
    expect(await repository.claimResume(OWNER_A, first.id, resumeJob.id)).toBeUndefined();
    // Cross-owner claims never see the run.
    expect(await repository.claimResume(OWNER_B, first.id, resumeJob.id)).toBeUndefined();
  });

  it("persists generations transactionally and restores objectives in (generation, fingerprint) order", async () => {
    const run = await createRun(OWNER_A);
    await repository.setDatasetFingerprint(run.id, "e".repeat(64));
    // The fingerprint is pinned once; later writes never overwrite it.
    await repository.setDatasetFingerprint(run.id, "f".repeat(64));
    expect((await repository.getRun(OWNER_A, run.id))?.datasetFingerprint).toBe("e".repeat(64));

    await repository.recordGeneration(run.id, {
      generation: 1,
      candidates: [candidateInput(OVERFIT_FP, 1, overfitOosReport()), candidateInput(CLEAN_FP, 1, cleanOosReport())],
      paretoRanks: new Map([[CLEAN_FP, 0], [OVERFIT_FP, 1]]),
      pareto: { schemaVersion: "ga-pareto-v1", generation: 1, totalCandidates: 2, frontier: [] },
      checkpoint: { schemaVersion: "ga-checkpoint-v1", generation: 1 }
    });

    const restored = await repository.restoreObjectives(run.id);
    expect(restored.map((row) => row.fingerprint)).toEqual([CLEAN_FP, OVERFIT_FP]);
    expect(restored[0]).toMatchObject({ generation: 1, objectives: { netProfitPct: 9, maxDrawdownPct: 4, sharpe: 1.1, complexity: 100 } });
    expect(restored[0]!.oosReport).toEqual(cleanOosReport());

    const updated = await repository.getRun(OWNER_A, run.id);
    expect(updated).toMatchObject({ currentGeneration: 1, checkpoint: { schemaVersion: "ga-checkpoint-v1", generation: 1 } });

    const page = await repository.listCandidates(OWNER_A, run.id, { generation: 1, limit: 10 });
    expect(page.map((row) => row.fingerprint)).toEqual([CLEAN_FP, OVERFIT_FP]);
    expect(page[0]).toMatchObject({ paretoRank: 0 });
    // Candidates stay invisible to other owners.
    expect(await repository.listCandidates(OWNER_B, run.id, { limit: 10 })).toEqual([]);
    expect(await repository.getCandidate(OWNER_B, run.id, CLEAN_FP)).toBeUndefined();
    expect((await repository.getLineage(OWNER_A, run.id)).map((row) => row.fingerprint)).toEqual([CLEAN_FP, OVERFIT_FP]);
  });

  it("gates promotion on a clean OOS report at both the repository and CHECK-constraint level", async () => {
    const run = await createRun(OWNER_A);
    await repository.recordGeneration(run.id, {
      generation: 1,
      candidates: [candidateInput(CLEAN_FP, 1, cleanOosReport()), candidateInput(OVERFIT_FP, 1, overfitOosReport())],
      paretoRanks: new Map([[CLEAN_FP, 0], [OVERFIT_FP, 1]]),
      pareto: { schemaVersion: "ga-pareto-v1", generation: 1, totalCandidates: 2, frontier: [] },
      checkpoint: { schemaVersion: "ga-checkpoint-v1" }
    });
    // A row whose oos_report is NULL (evidence never produced).
    await pool.query(
      `INSERT INTO ga_candidates (run_id, fingerprint, generation, ir, metrics, objectives)
       VALUES ($1, 'strategy-v1-cccccccccccccccc-1', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [run.id]
    );

    await expect(repository.promote(OWNER_A, run.id, "strategy-v1-cccccccccccccccc-1", 1)).rejects.toBeInstanceOf(GaPromotionRequiresOosError);
    await expect(repository.promote(OWNER_A, run.id, OVERFIT_FP, 1)).rejects.toBeInstanceOf(GaPromotionOverfitError);
    // The schema itself refuses promoted_at without out-of-sample evidence.
    await expect(
      pool.query("UPDATE ga_candidates SET promoted_at = 1 WHERE run_id = $1 AND fingerprint = 'strategy-v1-cccccccccccccccc-1'", [run.id])
    ).rejects.toMatchObject({ code: "23514" });

    const promoted = await repository.promote(OWNER_A, run.id, CLEAN_FP, 1_752_800_000_000);
    expect(promoted).toMatchObject({ fingerprint: CLEAN_FP, promotedAt: 1_752_800_000_000 });
    // Idempotent: the first promotion timestamp wins.
    const replay = await repository.promote(OWNER_A, run.id, CLEAN_FP, 1_752_800_999_999);
    expect(replay.promotedAt).toBe(1_752_800_000_000);
  });

  it("enforces the bounded-checkpoint and status CHECK constraints", async () => {
    const run = await createRun(OWNER_A);
    await expect(
      pool.query("UPDATE ga_runs SET checkpoint = $2::jsonb WHERE id = $1", [run.id, JSON.stringify({ pad: "x".repeat(525_000) })])
    ).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE ga_runs SET status = 'paused' WHERE id = $1", [run.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE ga_runs SET seed = -1 WHERE id = $1", [run.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE ga_runs SET current_generation = 17 WHERE id = $1", [run.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("self-heals orphaned running runs whose driving job is gone and reports active capacity", async () => {
    const run = await createRun(OWNER_A);
    expect(await repository.hasActiveRun(OWNER_A)).toBe(true);
    // The driving job is still queued: nothing to heal.
    expect(await repository.failOrphanedRuns(OWNER_A)).toBe(0);

    await pool.query("UPDATE compute_jobs SET status = 'failed', completed_at = NOW() WHERE id = $1", [run.jobId]);
    expect(await repository.failOrphanedRuns(OWNER_A)).toBe(1);
    expect((await repository.getRun(OWNER_A, run.id))?.status).toBe("failed");
    // A queued ga-evolution job still counts as active capacity on its own.
    expect(await repository.hasActiveRun(OWNER_A)).toBe(false);
    await enqueueJob(OWNER_A);
    expect(await repository.hasActiveRun(OWNER_A)).toBe(true);

    const runs = await repository.listRuns(OWNER_A, 10);
    expect(runs.map(({ id }) => id)).toEqual([run.id]);
    // The list projection never hydrates the (potentially large) checkpoint.
    expect(runs[0]!.checkpoint).toBeUndefined();
  });
});

async function enqueueJob(ownerUserId: string) {
  return jobs.enqueue({
    ownerUserId,
    jobType: "ga-evolution",
    payload: { kind: "ga-evolution", mode: "start" },
    estimatedCost: 2_000,
    dedupeKey: randomUUID()
  });
}

async function createRun(ownerUserId: string) {
  const job = await enqueueJob(ownerUserId);
  return repository.createRun({
    id: randomUUID(),
    ownerUserId,
    jobId: job.id,
    config: { markets: ["BTCUSDT"], timeframe: "1h", lookbackBars: 500, seed: 7, population: 8, generations: 2 },
    seed: 7,
    engineVersion: "backtest-core-v1",
    generatorVersion: "bounded-grammar-v1"
  });
}

function candidateInput(fingerprint: string, generation: number, oosReport: Record<string, unknown>): GaNewCandidateInput {
  return {
    fingerprint,
    generation,
    parentFingerprints: [],
    mutationLog: [],
    ir: { name: "GA candidate", inputs: [], body: [] },
    metrics: { markets: [{ symbol: "BTCUSDT", train: { netProfitPct: 10 }, outOfSample: { netProfitPct: 8 } }] },
    objectives: { netProfitPct: 9, maxDrawdownPct: 4, sharpe: 1.1, complexity: 100 },
    oosReport
  };
}

function cleanOosReport(): Record<string, unknown> {
  return { gapPct: { netProfitPct: 2.5 }, oosLossShare: 0, dispersion: 1.5, flags: { overfit: false, unstable: false } };
}

function overfitOosReport(): Record<string, unknown> {
  return { gapPct: { netProfitPct: 40 }, oosLossShare: 0.5, dispersion: 12, flags: { overfit: true, unstable: false } };
}
