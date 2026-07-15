import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type ComputeJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ComputeJob {
  id: string;
  ownerUserId: string;
  jobType: string;
  status: ComputeJobStatus;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  progress: number;
  estimatedCost: number;
  attempt: number;
  maxAttempts: number;
  cancelRequestedAt?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  owner_user_id: string;
  job_type: string;
  status: ComputeJobStatus;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  progress: number;
  estimated_cost: string;
  attempt: number;
  max_attempts: number;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  lease_token: string | null;
  client_request_id: string | null;
  dedupe_key: string | null;
}

export interface ClaimedJob extends ComputeJob {
  payload: Record<string, unknown>;
  leaseToken: string;
}

export class JobQuotaError extends Error {}

export class JobIdempotencyConflictError extends Error {}

const JOB_ADVISORY_LOCK_NAMESPACE = 1_932_088_610;

export class ComputeJobRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    ownerUserId: string;
    jobType: string;
    payload: Record<string, unknown>;
    estimatedCost: number;
    clientRequestId?: string;
    dedupeKey?: string;
  }): Promise<ComputeJob> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [JOB_ADVISORY_LOCK_NAMESPACE, input.ownerUserId]);
      if (input.clientRequestId) {
        const existingRequest = await client.query<JobRow>(
          `${selectJobSql()} WHERE owner_user_id = $1 AND client_request_id = $2 LIMIT 1`,
          [input.ownerUserId, input.clientRequestId]
        );
        const existing = existingRequest.rows[0];
        if (existing) {
          if (existing.job_type !== input.jobType || existing.dedupe_key !== (input.dedupeKey ?? null)) {
            throw new JobIdempotencyConflictError("The client request ID is already associated with a different job.");
          }
          return mapJob(existing);
        }
      }
      if (input.dedupeKey) {
        const existing = await client.query<JobRow>(
          `${selectJobSql()} WHERE owner_user_id = $1 AND job_type = $2 AND dedupe_key = $3
           AND status IN ('queued','running','completed') ORDER BY created_at DESC LIMIT 1`,
          [input.ownerUserId, input.jobType, input.dedupeKey]
        );
        if (existing.rows[0]) return mapJob(existing.rows[0]);
      }
      const count = await client.query<{ active: string }>(
        "SELECT count(*)::text AS active FROM compute_jobs WHERE owner_user_id = $1 AND status IN ('queued','running')",
        [input.ownerUserId]
      );
      if (Number(count.rows[0]?.active ?? 0) >= 5) throw new JobQuotaError("At most five queued or running jobs are allowed per user.");
      const result = await client.query<JobRow>(
        `INSERT INTO compute_jobs (
           id, owner_user_id, job_type, payload, estimated_cost, client_request_id, dedupe_key, max_attempts
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,2)
         RETURNING *`,
        [
          randomUUID(), input.ownerUserId, input.jobType, JSON.stringify(input.payload), input.estimatedCost,
          input.clientRequestId ?? null, input.dedupeKey ?? null
        ]
      );
      return mapJob(result.rows[0]!);
    });
  }

  async list(ownerUserId: string, limit = 50): Promise<ComputeJob[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.pool.query<JobRow>(
      `${selectJobSql(false)} WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ownerUserId, boundedLimit]
    );
    return result.rows.map(mapJob);
  }

  async get(ownerUserId: string, id: string): Promise<ComputeJob | undefined> {
    const result = await this.pool.query<JobRow>(`${selectJobSql()} WHERE owner_user_id = $1 AND id = $2`, [ownerUserId, id]);
    return result.rows[0] && mapJob(result.rows[0]);
  }

  async cancel(ownerUserId: string, id: string): Promise<ComputeJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `UPDATE compute_jobs SET
         cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         completed_at = CASE WHEN status = 'queued' THEN clock_timestamp() ELSE completed_at END,
         updated_at = clock_timestamp()
       WHERE owner_user_id = $1 AND id = $2 AND status IN ('queued','running')
       RETURNING *`,
      [ownerUserId, id]
    );
    return result.rows[0] && mapJob(result.rows[0]);
  }

  async claim(workerId: string, leaseMs: number): Promise<ClaimedJob | undefined> {
    const leaseToken = randomUUID();
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS MATERIALIZED (
         SELECT id, owner_user_id FROM compute_jobs j
         WHERE status = 'queued' AND cancel_requested_at IS NULL AND run_after <= clock_timestamp()
           AND attempt < max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM compute_jobs active
             WHERE active.owner_user_id = j.owner_user_id AND active.status = 'running'
           )
         ORDER BY priority DESC, run_after ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       ), locked_candidate AS MATERIALIZED (
         SELECT id, owner_user_id FROM candidate
         WHERE pg_try_advisory_xact_lock($4, hashtext(owner_user_id::text))
       ), eligible AS (
         SELECT id FROM locked_candidate candidate
         WHERE NOT EXISTS (
           SELECT 1 FROM compute_jobs active
           WHERE active.owner_user_id = candidate.owner_user_id AND active.status = 'running'
         )
       )
       UPDATE compute_jobs j SET
         status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, clock_timestamp()),
         lease_owner = $1, lease_token = $2, lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
         updated_at = clock_timestamp()
       FROM eligible WHERE j.id = eligible.id RETURNING j.*`,
      [workerId, leaseToken, leaseMs, JOB_ADVISORY_LOCK_NAMESPACE]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (!row.payload) throw new Error("Claimed compute job is missing its payload");
    return { ...mapJob(row), payload: row.payload, leaseToken };
  }

  async heartbeat(id: string, leaseToken: string, leaseMs: number, progress: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET progress = $3,
         lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'), updated_at = clock_timestamp()
       WHERE id = $1 AND lease_token = $2 AND status = 'running' AND cancel_requested_at IS NULL`,
      [id, leaseToken, Math.max(0, Math.min(1, progress)), leaseMs]
    );
    return result.rowCount === 1;
  }

  async cancellationRequested(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query<{ cancelled: boolean }>(
      "SELECT cancel_requested_at IS NOT NULL AS cancelled FROM compute_jobs WHERE id = $1 AND lease_token = $2",
      [id, leaseToken]
    );
    return result.rows[0]?.cancelled ?? true;
  }

  async complete(id: string, leaseToken: string, resultPayload: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN cancel_requested_at IS NULL THEN 'completed' ELSE 'cancelled' END,
         result = CASE WHEN cancel_requested_at IS NULL THEN $3::jsonb ELSE NULL END,
         progress = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE progress END,
         error_code = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'cancelled' END,
         error_message = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'Cancelled by user.' END,
         completed_at = clock_timestamp(), updated_at = clock_timestamp(),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [id, leaseToken, JSON.stringify(resultPayload)]
    );
    return result.rowCount === 1;
  }

  async fail(id: string, leaseToken: string, code: string, message: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
         error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $3 END,
         error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN 'Cancelled by user.' ELSE $4 END,
         completed_at = clock_timestamp(), updated_at = clock_timestamp(),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [id, leaseToken, code.slice(0, 96), message.slice(0, 4_000)]
    );
    return result.rowCount === 1;
  }

  async requeueForShutdown(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'queued' END,
         attempt = CASE WHEN cancel_requested_at IS NOT NULL THEN attempt ELSE GREATEST(0, attempt - 1) END,
         progress = CASE WHEN cancel_requested_at IS NOT NULL THEN progress ELSE 0 END,
         error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE NULL END,
         error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN 'Cancelled by user.' ELSE NULL END,
         run_after = clock_timestamp(),
         completed_at = CASE WHEN cancel_requested_at IS NOT NULL THEN clock_timestamp() ELSE NULL END,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [id, leaseToken]
    );
    return result.rowCount === 1;
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN attempt < max_attempts AND cancel_requested_at IS NULL THEN 'queued'
                       WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
         progress = CASE WHEN attempt < max_attempts AND cancel_requested_at IS NULL THEN 0 ELSE progress END,
         error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                           WHEN attempt < max_attempts THEN NULL
                           WHEN attempt >= max_attempts THEN 'worker_lease_expired' ELSE error_code END,
         error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN 'Cancelled by user.'
                              WHEN attempt < max_attempts THEN NULL
                              WHEN attempt >= max_attempts THEN 'Research worker lease expired.' ELSE error_message END,
         run_after = clock_timestamp() + interval '5 seconds',
         completed_at = CASE WHEN attempt >= max_attempts OR cancel_requested_at IS NOT NULL THEN clock_timestamp() ELSE NULL END,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
       WHERE status = 'running' AND lease_expires_at < clock_timestamp()`
    );
    return result.rowCount ?? 0;
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

function selectJobSql(includeDetails = true): string {
  const details = includeDetails ? "payload, result" : "NULL::jsonb AS payload, NULL::jsonb AS result";
  return `SELECT id, owner_user_id, job_type, status, ${details}, error_code, error_message,
    progress, estimated_cost, attempt, max_attempts, cancel_requested_at, created_at, started_at,
    completed_at, updated_at, lease_token, client_request_id, dedupe_key FROM compute_jobs`;
}

function mapJob(row: JobRow): ComputeJob {
  const estimatedCost = Number(row.estimated_cost);
  if (!Number.isSafeInteger(estimatedCost) || estimatedCost < 0) throw new Error("Invalid compute job cost");
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    jobType: row.job_type,
    status: row.status,
    ...(row.payload ? { payload: row.payload } : {}),
    ...(row.result ? { result: row.result } : {}),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    progress: row.progress,
    estimatedCost,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    cancelRequestedAt: row.cancel_requested_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
