import type { Pool, PoolClient } from "pg";

/**
 * Owner-scoped persistence for server GA evolution runs and their candidate
 * lineage (PG schema v17, R9.2). The single-active-run invariant is enforced
 * by the `ga_runs_one_active_per_owner` partial unique index — this class
 * only translates that violation into a typed error. Promotion is refused at
 * the data layer unless the candidate carries a clean out-of-sample report,
 * mirroring the `promoted_at IS NULL OR oos_report IS NOT NULL` CHECK.
 */

export type GaRunStatus = "running" | "checkpointed" | "completed" | "failed" | "cancelled";

export interface GaRunRecord {
  id: string;
  ownerUserId: string;
  jobId?: string;
  status: GaRunStatus;
  config: Record<string, unknown>;
  seed: number;
  datasetFingerprint?: string;
  engineVersion: string;
  generatorVersion: string;
  currentGeneration: number;
  checkpoint?: Record<string, unknown>;
  pareto?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GaCandidateRecord {
  runId: string;
  fingerprint: string;
  generation: number;
  parentFingerprints: string[];
  mutationLog: unknown[];
  ir: Record<string, unknown>;
  metrics: Record<string, unknown>;
  objectives: Record<string, number>;
  paretoRank?: number;
  oosReport?: Record<string, unknown>;
  promotedAt?: number;
  createdAt: string;
}

/** New lineage row captured when a generation completes. */
export interface GaNewCandidateInput {
  fingerprint: string;
  generation: number;
  parentFingerprints: string[];
  mutationLog: unknown[];
  ir: Record<string, unknown>;
  metrics: Record<string, unknown>;
  objectives: Record<string, number>;
  oosReport: Record<string, unknown>;
}

export class GaRunActiveError extends Error {}
export class GaPromotionRequiresOosError extends Error {}
export class GaPromotionOverfitError extends Error {}

export interface GaEvolutionLineageStore {
  failOrphanedRuns(ownerUserId: string): Promise<number>;
  hasActiveRun(ownerUserId: string): Promise<boolean>;
  findRunByJobId(ownerUserId: string, jobId: string): Promise<GaRunRecord | undefined>;
  getRun(ownerUserId: string, runId: string): Promise<GaRunRecord | undefined>;
  createRun(input: { id: string; ownerUserId: string; jobId: string; config: Record<string, unknown>; seed: number; engineVersion: string; generatorVersion: string }): Promise<GaRunRecord>;
  claimResume(ownerUserId: string, runId: string, jobId: string): Promise<GaRunRecord | undefined>;
  setDatasetFingerprint(runId: string, fingerprint: string): Promise<void>;
  restoreObjectives(runId: string): Promise<{ fingerprint: string; generation: number; objectives: Record<string, number>; oosReport?: Record<string, unknown> }[]>;
  recordGeneration(runId: string, input: { generation: number; candidates: readonly GaNewCandidateInput[]; paretoRanks: ReadonlyMap<string, number>; pareto: Record<string, unknown>; checkpoint: Record<string, unknown> }): Promise<void>;
  finishRun(runId: string, input: { status: Exclude<GaRunStatus, "running">; checkpoint?: Record<string, unknown>; pareto?: Record<string, unknown> }): Promise<void>;
  listRuns(ownerUserId: string, limit: number): Promise<GaRunRecord[]>;
  listCandidates(ownerUserId: string, runId: string, options: { generation?: number; limit: number }): Promise<GaCandidateRecord[]>;
  getCandidate(ownerUserId: string, runId: string, fingerprint: string): Promise<GaCandidateRecord | undefined>;
  getLineage(ownerUserId: string, runId: string): Promise<Pick<GaCandidateRecord, "fingerprint" | "generation" | "parentFingerprints" | "mutationLog">[]>;
  promote(ownerUserId: string, runId: string, fingerprint: string, promotedAt: number): Promise<GaCandidateRecord>;
}

interface GaRunRow {
  id: string;
  owner_user_id: string;
  job_id: string | null;
  status: GaRunStatus;
  config: Record<string, unknown>;
  seed: string | number;
  dataset_fingerprint: string | null;
  engine_version: string;
  generator_version: string;
  current_generation: number;
  checkpoint: Record<string, unknown> | null;
  pareto: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface GaCandidateRow {
  run_id: string;
  fingerprint: string;
  generation: number;
  parent_fingerprints: unknown;
  mutation_log: unknown;
  ir: Record<string, unknown>;
  metrics: Record<string, unknown>;
  objectives: Record<string, number>;
  pareto_rank: number | null;
  oos_report: Record<string, unknown> | null;
  promoted_at: string | number | null;
  created_at: Date;
}

const RUN_COLUMNS = "id, owner_user_id, job_id, status, config, seed, dataset_fingerprint, engine_version, generator_version, current_generation, checkpoint, pareto, created_at, updated_at";
const RUN_LIST_COLUMNS = "id, owner_user_id, job_id, status, config, seed, dataset_fingerprint, engine_version, generator_version, current_generation, NULL::jsonb AS checkpoint, pareto, created_at, updated_at";
const CANDIDATE_COLUMNS = "run_id, fingerprint, generation, parent_fingerprints, mutation_log, ir, metrics, objectives, pareto_rank, oos_report, promoted_at, created_at";

export class GaEvolutionRepository implements GaEvolutionLineageStore {
  constructor(private readonly pool: Pool) {}

  /** Self-heal: a 'running' run whose driving job is no longer queued/running can never finish. */
  async failOrphanedRuns(ownerUserId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ga_runs runs SET status = 'failed', updated_at = now()
       WHERE runs.owner_user_id = $1 AND runs.status = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM compute_jobs jobs
           WHERE jobs.id = runs.job_id AND jobs.status IN ('queued', 'running')
         )`,
      [ownerUserId]
    );
    return result.rowCount ?? 0;
  }

  async hasActiveRun(ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM compute_jobs
         WHERE owner_user_id = $1 AND job_type = 'ga-evolution' AND status IN ('queued', 'running')
       ) OR EXISTS (
         SELECT 1 FROM ga_runs WHERE owner_user_id = $1 AND status = 'running'
       ) AS active`,
      [ownerUserId]
    );
    return result.rows[0]?.active === true;
  }

  async findRunByJobId(ownerUserId: string, jobId: string): Promise<GaRunRecord | undefined> {
    const result = await this.pool.query<GaRunRow>(`SELECT ${RUN_COLUMNS} FROM ga_runs WHERE owner_user_id = $1 AND job_id = $2 LIMIT 1`, [ownerUserId, jobId]);
    return result.rows[0] && mapRun(result.rows[0]);
  }

  async getRun(ownerUserId: string, runId: string): Promise<GaRunRecord | undefined> {
    const result = await this.pool.query<GaRunRow>(`SELECT ${RUN_COLUMNS} FROM ga_runs WHERE owner_user_id = $1 AND id = $2`, [ownerUserId, runId]);
    return result.rows[0] && mapRun(result.rows[0]);
  }

  async createRun(input: { id: string; ownerUserId: string; jobId: string; config: Record<string, unknown>; seed: number; engineVersion: string; generatorVersion: string }): Promise<GaRunRecord> {
    try {
      const result = await this.pool.query<GaRunRow>(
        `INSERT INTO ga_runs (id, owner_user_id, job_id, status, config, seed, engine_version, generator_version)
         VALUES ($1, $2, $3, 'running', $4::jsonb, $5, $6, $7)
         RETURNING ${RUN_COLUMNS}`,
        [input.id, input.ownerUserId, input.jobId, JSON.stringify(input.config), input.seed, input.engineVersion, input.generatorVersion]
      );
      return mapRun(result.rows[0]!);
    } catch (error) {
      if (isOneActivePerOwnerViolation(error)) throw new GaRunActiveError("Another GA evolution run is already active for this owner.");
      throw error;
    }
  }

  /** Atomically claim a checkpointed run for one resume job; undefined when not resumable. */
  async claimResume(ownerUserId: string, runId: string, jobId: string): Promise<GaRunRecord | undefined> {
    try {
      const result = await this.pool.query<GaRunRow>(
        `UPDATE ga_runs SET status = 'running', job_id = $3, updated_at = now()
         WHERE owner_user_id = $1 AND id = $2 AND status = 'checkpointed'
         RETURNING ${RUN_COLUMNS}`,
        [ownerUserId, runId, jobId]
      );
      return result.rows[0] && mapRun(result.rows[0]);
    } catch (error) {
      if (isOneActivePerOwnerViolation(error)) throw new GaRunActiveError("Another GA evolution run is already active for this owner.");
      throw error;
    }
  }

  async setDatasetFingerprint(runId: string, fingerprint: string): Promise<void> {
    await this.pool.query("UPDATE ga_runs SET dataset_fingerprint = $2, updated_at = now() WHERE id = $1 AND dataset_fingerprint IS NULL", [runId, fingerprint]);
  }

  /** Everything a resume needs from prior generations: the dedup registry and ranking inputs. */
  async restoreObjectives(runId: string): Promise<{ fingerprint: string; generation: number; objectives: Record<string, number>; oosReport?: Record<string, unknown> }[]> {
    const result = await this.pool.query<Pick<GaCandidateRow, "fingerprint" | "generation" | "objectives" | "oos_report">>(
      "SELECT fingerprint, generation, objectives, oos_report FROM ga_candidates WHERE run_id = $1 ORDER BY generation ASC, fingerprint ASC",
      [runId]
    );
    return result.rows.map((row) => ({
      fingerprint: row.fingerprint,
      generation: row.generation,
      objectives: row.objectives,
      ...(row.oos_report ? { oosReport: row.oos_report } : {})
    }));
  }

  /** One transaction per completed generation: lineage rows + fresh Pareto ranks + checkpoint. */
  async recordGeneration(runId: string, input: { generation: number; candidates: readonly GaNewCandidateInput[]; paretoRanks: ReadonlyMap<string, number>; pareto: Record<string, unknown>; checkpoint: Record<string, unknown> }): Promise<void> {
    await this.transaction(async (client) => {
      for (const candidate of input.candidates) {
        await client.query(
          `INSERT INTO ga_candidates (run_id, fingerprint, generation, parent_fingerprints, mutation_log, ir, metrics, objectives, oos_report)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
          [
            runId,
            candidate.fingerprint,
            candidate.generation,
            JSON.stringify(candidate.parentFingerprints),
            JSON.stringify(candidate.mutationLog),
            JSON.stringify(candidate.ir),
            JSON.stringify(candidate.metrics),
            JSON.stringify(candidate.objectives),
            JSON.stringify(candidate.oosReport)
          ]
        );
      }
      const fingerprints = [...input.paretoRanks.keys()];
      const ranks = fingerprints.map((fingerprint) => input.paretoRanks.get(fingerprint)!);
      await client.query(
        `UPDATE ga_candidates SET pareto_rank = ranked.rank
         FROM (SELECT unnest($2::varchar[]) AS fingerprint, unnest($3::int[]) AS rank) ranked
         WHERE ga_candidates.run_id = $1 AND ga_candidates.fingerprint = ranked.fingerprint`,
        [runId, fingerprints, ranks]
      );
      await client.query(
        "UPDATE ga_runs SET current_generation = $2, pareto = $3::jsonb, checkpoint = $4::jsonb, updated_at = now() WHERE id = $1",
        [runId, input.generation, JSON.stringify(input.pareto), JSON.stringify(input.checkpoint)]
      );
    });
  }

  async finishRun(runId: string, input: { status: Exclude<GaRunStatus, "running">; checkpoint?: Record<string, unknown>; pareto?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `UPDATE ga_runs SET status = $2,
         checkpoint = COALESCE($3::jsonb, checkpoint),
         pareto = COALESCE($4::jsonb, pareto),
         updated_at = now()
       WHERE id = $1`,
      [runId, input.status, input.checkpoint ? JSON.stringify(input.checkpoint) : null, input.pareto ? JSON.stringify(input.pareto) : null]
    );
  }

  async listRuns(ownerUserId: string, limit: number): Promise<GaRunRecord[]> {
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    const result = await this.pool.query<GaRunRow>(
      `SELECT ${RUN_LIST_COLUMNS} FROM ga_runs WHERE owner_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [ownerUserId, bounded]
    );
    return result.rows.map(mapRun);
  }

  async listCandidates(ownerUserId: string, runId: string, options: { generation?: number; limit: number }): Promise<GaCandidateRecord[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const generationFilter = options.generation !== undefined ? "AND candidates.generation = $3" : "";
    const parameters: unknown[] = [ownerUserId, runId];
    if (options.generation !== undefined) parameters.push(options.generation);
    parameters.push(bounded);
    const result = await this.pool.query<GaCandidateRow>(
      `SELECT ${candidateColumns()} FROM ga_candidates candidates
       INNER JOIN ga_runs runs ON runs.id = candidates.run_id AND runs.owner_user_id = $1
       WHERE candidates.run_id = $2 ${generationFilter}
       ORDER BY candidates.generation ASC, candidates.fingerprint ASC
       LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(mapCandidate);
  }

  async getCandidate(ownerUserId: string, runId: string, fingerprint: string): Promise<GaCandidateRecord | undefined> {
    const result = await this.pool.query<GaCandidateRow>(
      `SELECT ${candidateColumns()} FROM ga_candidates candidates
       INNER JOIN ga_runs runs ON runs.id = candidates.run_id AND runs.owner_user_id = $1
       WHERE candidates.run_id = $2 AND candidates.fingerprint = $3`,
      [ownerUserId, runId, fingerprint]
    );
    return result.rows[0] && mapCandidate(result.rows[0]);
  }

  /** Bounded ancestry material for lineage-chain assembly (<= 64 x 16 rows per run). */
  async getLineage(ownerUserId: string, runId: string): Promise<Pick<GaCandidateRecord, "fingerprint" | "generation" | "parentFingerprints" | "mutationLog">[]> {
    const result = await this.pool.query<Pick<GaCandidateRow, "fingerprint" | "generation" | "parent_fingerprints" | "mutation_log">>(
      `SELECT candidates.fingerprint, candidates.generation, candidates.parent_fingerprints, candidates.mutation_log
       FROM ga_candidates candidates
       INNER JOIN ga_runs runs ON runs.id = candidates.run_id AND runs.owner_user_id = $1
       WHERE candidates.run_id = $2
       ORDER BY candidates.generation ASC, candidates.fingerprint ASC`,
      [ownerUserId, runId]
    );
    return result.rows.map((row) => ({
      fingerprint: row.fingerprint,
      generation: row.generation,
      parentFingerprints: stringArray(row.parent_fingerprints),
      mutationLog: unknownArray(row.mutation_log)
    }));
  }

  /**
   * Stamp promoted_at (idempotent: the first promotion time wins). Refuses
   * candidates without an OOS report or with the overfit flag set — the
   * roadmap invariant that nothing ships without out-of-sample evidence.
   */
  async promote(ownerUserId: string, runId: string, fingerprint: string, promotedAt: number): Promise<GaCandidateRecord> {
    return this.transaction(async (client) => {
      const existing = await client.query<GaCandidateRow>(
        `SELECT ${candidateColumns()} FROM ga_candidates candidates
         INNER JOIN ga_runs runs ON runs.id = candidates.run_id AND runs.owner_user_id = $1
         WHERE candidates.run_id = $2 AND candidates.fingerprint = $3
         FOR UPDATE OF candidates`,
        [ownerUserId, runId, fingerprint]
      );
      const row = existing.rows[0];
      if (!row) throw new GaCandidateNotFoundError("GA candidate not found.");
      if (!row.oos_report) throw new GaPromotionRequiresOosError("Promotion requires an out-of-sample report.");
      if (isOverfitReport(row.oos_report)) throw new GaPromotionOverfitError("Promotion refused: the candidate is flagged as overfit out of sample.");
      const updated = await client.query<GaCandidateRow>(
        `UPDATE ga_candidates SET promoted_at = COALESCE(promoted_at, $3)
         WHERE run_id = $1 AND fingerprint = $2
         RETURNING ${CANDIDATE_COLUMNS}`,
        [runId, fingerprint, promotedAt]
      );
      return mapCandidate(updated.rows[0]!);
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class GaCandidateNotFoundError extends Error {}

function candidateColumns(): string {
  return CANDIDATE_COLUMNS.split(", ")
    .map((column) => `candidates.${column}`)
    .join(", ");
}

function isOneActivePerOwnerViolation(error: unknown): boolean {
  const value = error as { code?: unknown; constraint?: unknown } | undefined;
  return value?.code === "23505" && value.constraint === "ga_runs_one_active_per_owner";
}

export function isOverfitReport(report: Record<string, unknown>): boolean {
  const flags = report.flags;
  return !!flags && typeof flags === "object" && (flags as { overfit?: unknown }).overfit === true;
}

function mapRun(row: GaRunRow): GaRunRecord {
  const seed = Number(row.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid GA run seed");
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    status: row.status,
    config: row.config,
    seed,
    ...(row.dataset_fingerprint ? { datasetFingerprint: row.dataset_fingerprint } : {}),
    engineVersion: row.engine_version,
    generatorVersion: row.generator_version,
    currentGeneration: row.current_generation,
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    ...(row.pareto ? { pareto: row.pareto } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapCandidate(row: GaCandidateRow): GaCandidateRecord {
  return {
    runId: row.run_id,
    fingerprint: row.fingerprint,
    generation: row.generation,
    parentFingerprints: stringArray(row.parent_fingerprints),
    mutationLog: unknownArray(row.mutation_log),
    ir: row.ir,
    metrics: row.metrics,
    objectives: row.objectives,
    ...(row.pareto_rank !== null ? { paretoRank: row.pareto_rank } : {}),
    ...(row.oos_report ? { oosReport: row.oos_report } : {}),
    ...(row.promoted_at !== null ? { promotedAt: Number(row.promoted_at) } : {}),
    createdAt: row.created_at.toISOString()
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
