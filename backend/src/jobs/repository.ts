import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ComputeJobResultRejectedError, serializeComputeJobResult } from "./resultPayload.js";

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
  artifactsExpired: boolean;
  artifactsPrunedAt?: string;
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
  artifacts_pruned_at: Date | null;
  updated_at: Date;
  lease_token: string | null;
  client_request_id: string | null;
  dedupe_key: string | null;
}

export interface ClaimedJob extends ComputeJob {
  payload: Record<string, unknown>;
  leaseToken: string;
}

export interface ComputeJobMetrics {
  queueDepth: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  terminalWindowSeconds: number;
  terminalSampleLimit: number;
  terminalSampleTruncated: boolean;
  oldestQueuedAgeSeconds: number;
  durationSeconds: {
    samples: number;
    average: number;
    p95: number;
  };
}

interface JobMetricsRow {
  queue_depth: string;
  running: string;
  completed: string;
  failed: string;
  cancelled: string;
  duration_samples: string;
  oldest_queued_age_seconds: number;
  average_duration_seconds: number;
  p95_duration_seconds: number;
  terminal_sample_truncated: boolean;
}

export class JobQuotaError extends Error {}

export class JobIdempotencyConflictError extends Error {}

const JOB_ADVISORY_LOCK_NAMESPACE = 1_932_088_610;
const TRANSIENT_RETRY_BASE_MS = 2_000;
const TRANSIENT_RETRY_MAX_MS = 60_000;
const METRICS_TERMINAL_WINDOW_SECONDS = 24 * 60 * 60;
const METRICS_TERMINAL_SAMPLE_LIMIT = 10_000;

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
    const serializedPayload = JSON.stringify(input.payload);
    const artifactSizeBytes = Buffer.byteLength(serializedPayload, "utf8");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [JOB_ADVISORY_LOCK_NAMESPACE, input.ownerUserId]);
      if (input.clientRequestId) {
        const existingRequest = await client.query<JobRow>(`${selectJobSql()} WHERE owner_user_id = $1 AND client_request_id = $2 LIMIT 1`, [input.ownerUserId, input.clientRequestId]);
        const existing = existingRequest.rows[0];
        if (existing) {
          if (existing.job_type !== input.jobType || existing.dedupe_key !== (input.dedupeKey ?? null)) {
            throw new JobIdempotencyConflictError("The client request ID is already associated with a different job.");
          }
          return mapJob(existing);
        }
      }
      // A new exact request ID represents a new request and must be stored on
      // its own row. Otherwise returning a content duplicate would leave that
      // request ID unrecorded and a later retry could run again after pruning.
      if (input.dedupeKey && !input.clientRequestId) {
        const existing = await client.query<JobRow>(
          `${selectJobSql()} WHERE owner_user_id = $1 AND job_type = $2 AND dedupe_key = $3
           AND status IN ('queued','running','completed') AND artifacts_pruned_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [input.ownerUserId, input.jobType, input.dedupeKey]
        );
        if (existing.rows[0]) return mapJob(existing.rows[0]);
      }
      const count = await client.query<{ active: string }>("SELECT count(*)::text AS active FROM compute_jobs WHERE owner_user_id = $1 AND status IN ('queued','running')", [input.ownerUserId]);
      if (Number(count.rows[0]?.active ?? 0) >= 5) throw new JobQuotaError("At most five queued or running jobs are allowed per user.");
      const result = await client.query<JobRow>(
        `INSERT INTO compute_jobs (
           id, owner_user_id, job_type, payload, estimated_cost, client_request_id, dedupe_key,
           max_attempts, artifact_size_bytes
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,2,$8)
         RETURNING *`,
        [randomUUID(), input.ownerUserId, input.jobType, serializedPayload, input.estimatedCost, input.clientRequestId ?? null, input.dedupeKey ?? null, artifactSizeBytes]
      );
      return mapJob(result.rows[0]!);
    });
  }

  async list(ownerUserId: string, limit = 50): Promise<ComputeJob[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.pool.query<JobRow>(`${selectJobSql(false)} WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2`, [ownerUserId, boundedLimit]);
    return result.rows.map(mapJob);
  }

  async get(ownerUserId: string, id: string): Promise<ComputeJob | undefined> {
    const result = await this.pool.query<JobRow>(`${selectJobSql()} WHERE owner_user_id = $1 AND id = $2`, [ownerUserId, id]);
    return result.rows[0] && mapJob(result.rows[0]);
  }

  async getOwnerMetrics(ownerUserId: string): Promise<ComputeJobMetrics> {
    const result = await this.pool.query<JobMetricsRow>(jobMetricsSql(true), [ownerUserId]);
    return mapJobMetrics(result.rows[0]);
  }

  async getAggregateMetrics(): Promise<ComputeJobMetrics> {
    const result = await this.pool.query<JobMetricsRow>(jobMetricsSql(false));
    return mapJobMetrics(result.rows[0]);
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
      `WITH owner_heads AS MATERIALIZED (
         SELECT DISTINCT ON (j.owner_user_id)
           j.id, j.owner_user_id, j.priority, j.run_after, j.created_at
         FROM compute_jobs j
         WHERE j.status = 'queued' AND j.cancel_requested_at IS NULL AND j.run_after <= clock_timestamp()
           AND j.attempt < j.max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM compute_jobs active
             WHERE active.owner_user_id = j.owner_user_id AND active.status = 'running'
           )
         ORDER BY j.owner_user_id, j.priority DESC, j.run_after ASC, j.created_at ASC
       ), candidate AS MATERIALIZED (
         SELECT j.id, j.owner_user_id
         FROM compute_jobs j
         INNER JOIN owner_heads head ON head.id = j.id
         ORDER BY head.priority DESC, head.run_after ASC, head.created_at ASC
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
       ), claimed AS (
         UPDATE compute_jobs j SET
           status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, clock_timestamp()),
           lease_owner = $1, lease_token = $2, lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
           error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = clock_timestamp()
         FROM eligible WHERE j.id = eligible.id RETURNING j.*
       ), rotated AS (
         UPDATE compute_jobs pending SET
           run_after = GREATEST(pending.run_after, clock_timestamp()),
           updated_at = clock_timestamp()
         FROM claimed
         WHERE pending.owner_user_id = claimed.owner_user_id
           AND pending.status = 'queued' AND pending.id <> claimed.id
         RETURNING pending.id
       )
       SELECT claimed.* FROM claimed
       LEFT JOIN (SELECT count(*) AS rotated_count FROM rotated) rotation ON TRUE`,
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
       WHERE id = $1 AND lease_token = $2 AND status = 'running' AND cancel_requested_at IS NULL
         AND lease_expires_at > clock_timestamp()`,
      [id, leaseToken, Math.max(0, Math.min(1, progress)), leaseMs]
    );
    return result.rowCount === 1;
  }

  async cancellationRequested(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query<{ cancelled: boolean }>(
      `SELECT cancel_requested_at IS NOT NULL AS cancelled FROM compute_jobs
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
         AND lease_expires_at > clock_timestamp()`,
      [id, leaseToken]
    );
    return result.rows[0]?.cancelled ?? true;
  }

  async complete(id: string, leaseToken: string, resultPayload: Record<string, unknown>): Promise<boolean> {
    let serializedResult: string;
    try {
      serializedResult = serializeComputeJobResult(resultPayload);
    } catch (error) {
      if (error instanceof ComputeJobResultRejectedError) {
        return this.fail(id, leaseToken, error.code, error.message);
      }
      throw error;
    }
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN cancel_requested_at IS NULL THEN 'completed' ELSE 'cancelled' END,
         result = CASE WHEN cancel_requested_at IS NULL THEN $3::jsonb ELSE NULL END,
         artifact_size_bytes = artifact_size_bytes
           + CASE WHEN cancel_requested_at IS NULL THEN $4::bigint ELSE 0 END,
         progress = CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE progress END,
         error_code = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'cancelled' END,
         error_message = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE 'Cancelled by user.' END,
         completed_at = clock_timestamp(), updated_at = clock_timestamp(),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
         AND lease_expires_at > clock_timestamp()`,
      [id, leaseToken, serializedResult, Buffer.byteLength(serializedResult, "utf8")]
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
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
         AND lease_expires_at > clock_timestamp()`,
      [id, leaseToken, code.slice(0, 96), message.slice(0, 4_000)]
    );
    return result.rowCount === 1;
  }

  /**
   * Requeue failures that are safe to retry while the caller still owns a
   * live lease. Deterministic task errors must use fail() instead.
   */
  async retryOrFail(id: string, leaseToken: string, code: string, message: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE compute_jobs SET
         status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                       WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
         progress = CASE WHEN cancel_requested_at IS NULL AND attempt < max_attempts THEN 0 ELSE progress END,
         error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $3 END,
         error_message = CASE WHEN cancel_requested_at IS NOT NULL THEN 'Cancelled by user.' ELSE $4 END,
         run_after = CASE WHEN cancel_requested_at IS NULL AND attempt < max_attempts
           THEN clock_timestamp() + (
             LEAST(
               $6::double precision,
               $5::double precision * power(2::double precision, GREATEST(0, attempt - 1)::double precision)
             ) * interval '1 millisecond'
           ) ELSE run_after END,
         completed_at = CASE WHEN cancel_requested_at IS NOT NULL OR attempt >= max_attempts
           THEN clock_timestamp() ELSE NULL END,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
         AND lease_expires_at > clock_timestamp()`,
      [id, leaseToken, code.slice(0, 96), message.slice(0, 4_000), TRANSIENT_RETRY_BASE_MS, TRANSIENT_RETRY_MAX_MS]
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
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
         AND lease_expires_at > clock_timestamp()`,
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
         run_after = CASE WHEN attempt < max_attempts AND cancel_requested_at IS NULL
           THEN clock_timestamp() + (
             LEAST(
               $2::double precision,
               $1::double precision * power(2::double precision, GREATEST(0, attempt - 1)::double precision)
             ) * interval '1 millisecond'
           ) ELSE run_after END,
         completed_at = CASE WHEN attempt >= max_attempts OR cancel_requested_at IS NOT NULL THEN clock_timestamp() ELSE NULL END,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
       WHERE status = 'running' AND lease_expires_at < clock_timestamp()`,
      [TRANSIENT_RETRY_BASE_MS, TRANSIENT_RETRY_MAX_MS]
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

/**
 * Claim only while the supervisor accepts new work. The second stop check is
 * intentionally after the awaited claim so a concurrent shutdown returns the
 * fresh lease instead of starting a task that shutdown did not observe.
 */
export async function claimJobForExecution(repository: Pick<ComputeJobRepository, "claim" | "requeueForShutdown">, workerId: string, leaseMs: number, isStopping: () => boolean): Promise<ClaimedJob | undefined> {
  if (isStopping()) return undefined;
  const job = await repository.claim(workerId, leaseMs);
  if (!job) return undefined;
  if (!isStopping()) return job;
  await repository.requeueForShutdown(job.id, job.leaseToken);
  return undefined;
}

function selectJobSql(includeDetails = true): string {
  const details = includeDetails ? "payload, result" : "NULL::jsonb AS payload, NULL::jsonb AS result";
  return `SELECT id, owner_user_id, job_type, status, ${details}, error_code, error_message,
    progress, estimated_cost, attempt, max_attempts, cancel_requested_at, created_at, started_at,
    completed_at, artifacts_pruned_at, updated_at, lease_token, client_request_id, dedupe_key FROM compute_jobs`;
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
    artifactsExpired: row.artifacts_pruned_at != null,
    artifactsPrunedAt: row.artifacts_pruned_at?.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function jobMetricsSql(ownerScoped: boolean): string {
  const ownerFilter = ownerScoped ? "AND owner_user_id = $1" : "";
  return `WITH metric_clock AS MATERIALIZED (
      SELECT
        statement_timestamp() AS observed_at,
        statement_timestamp() - (${METRICS_TERMINAL_WINDOW_SECONDS} * interval '1 second') AS terminal_cutoff
    ), active_metrics AS MATERIALIZED (
      SELECT
        count(*) FILTER (WHERE status = 'queued')::text AS queue_depth,
        count(*) FILTER (WHERE status = 'running')::text AS running,
        COALESCE(EXTRACT(EPOCH FROM (
          (SELECT observed_at FROM metric_clock) - min(created_at) FILTER (WHERE status = 'queued')
        )), 0)::double precision
          AS oldest_queued_age_seconds
      FROM compute_jobs
      WHERE status IN ('queued', 'running') ${ownerFilter}
    ), terminal_candidates AS MATERIALIZED (
      SELECT status, started_at, completed_at
      FROM compute_jobs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at >= (SELECT terminal_cutoff FROM metric_clock)
        ${ownerFilter}
      ORDER BY completed_at DESC
      LIMIT ${METRICS_TERMINAL_SAMPLE_LIMIT + 1}
    ), terminal_sample AS MATERIALIZED (
      SELECT status, started_at, completed_at
      FROM terminal_candidates
      ORDER BY completed_at DESC
      LIMIT ${METRICS_TERMINAL_SAMPLE_LIMIT}
    )
    SELECT
      active_metrics.queue_depth,
      active_metrics.running,
      (SELECT count(*)::text FROM terminal_sample WHERE status = 'completed') AS completed,
      (SELECT count(*)::text FROM terminal_sample WHERE status = 'failed') AS failed,
      (SELECT count(*)::text FROM terminal_sample WHERE status = 'cancelled') AS cancelled,
      (SELECT count(*)::text FROM terminal_sample
        WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) AS duration_samples,
      active_metrics.oldest_queued_age_seconds,
      COALESCE((SELECT avg(EXTRACT(EPOCH FROM (completed_at - started_at)))
        FROM terminal_sample
        WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL), 0)::double precision
        AS average_duration_seconds,
      COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at))
        ) FROM terminal_sample
        WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL), 0)::double precision
        AS p95_duration_seconds,
      (SELECT count(*) > ${METRICS_TERMINAL_SAMPLE_LIMIT} FROM terminal_candidates) AS terminal_sample_truncated
    FROM active_metrics`;
}

function mapJobMetrics(row: JobMetricsRow | undefined): ComputeJobMetrics {
  return {
    queueDepth: boundedMetric(row?.queue_depth),
    running: boundedMetric(row?.running),
    completed: boundedMetric(row?.completed),
    failed: boundedMetric(row?.failed),
    cancelled: boundedMetric(row?.cancelled),
    terminalWindowSeconds: METRICS_TERMINAL_WINDOW_SECONDS,
    terminalSampleLimit: METRICS_TERMINAL_SAMPLE_LIMIT,
    terminalSampleTruncated: row?.terminal_sample_truncated === true,
    oldestQueuedAgeSeconds: boundedMetric(row?.oldest_queued_age_seconds, 3),
    durationSeconds: {
      samples: boundedMetric(row?.duration_samples),
      average: boundedMetric(row?.average_duration_seconds, 3),
      p95: boundedMetric(row?.p95_duration_seconds, 3)
    }
  };
}

function boundedMetric(value: string | number | undefined, fractionalDigits = 0): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const bounded = Math.min(Number.MAX_SAFE_INTEGER, parsed);
  if (fractionalDigits === 0) return Math.floor(bounded);
  const scale = 10 ** fractionalDigits;
  return Math.round(bounded * scale) / scale;
}
