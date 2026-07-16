import type { Pool, PoolClient } from "pg";

const JOB_ADVISORY_LOCK_NAMESPACE = 1_932_088_610;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const OWNER_SCAN_LIMIT = 32;

export const COMPUTE_JOB_FULL_ARTIFACT_RETENTION_DAYS = 30;
export const COMPUTE_JOB_TOMBSTONE_RETENTION_DAYS = 90;
export const COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER = 200;
export const COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER = 256 * 1024 * 1024;
export const COMPUTE_JOB_TOMBSTONES_PER_OWNER = 1_000;
export const COMPUTE_JOB_RETENTION_BATCH_LIMIT = 50;

interface CandidateOwnerRow {
  owner_user_id: string;
}

interface UsageRow {
  terminal_artifact_count: string;
  terminal_artifact_bytes: string;
  tombstone_count: string;
}

interface RetentionUsage {
  terminalArtifactCount: bigint;
  terminalArtifactBytes: bigint;
  tombstoneCount: bigint;
}

export interface ComputeJobRetentionResult {
  ownersScanned: number;
  ownersLocked: number;
  artifactsCompacted: number;
  tombstonesDeleted: number;
  batchLimit: number;
  remainingWorkLikely: boolean;
}

/**
 * Applies bounded retention without scanning or summing an owner's complete
 * history. PostgreSQL maintains exact counters transactionally; each selected
 * owner is fenced by the same advisory lock used by enqueue/idempotency.
 */
export class ComputeJobArtifactRetention {
  constructor(private readonly pool: Pool) {}

  async enforce(now = new Date(), batchSize = COMPUTE_JOB_RETENTION_BATCH_LIMIT): Promise<ComputeJobRetentionResult> {
    if (!Number.isFinite(now.getTime())) throw new Error("Job retention time must be a valid date");
    if (!Number.isFinite(batchSize)) throw new Error("Job retention batch size must be finite");
    const batchLimit = Math.max(1, Math.min(COMPUTE_JOB_RETENTION_BATCH_LIMIT, Math.floor(batchSize)));
    const artifactCutoff = new Date(now.getTime() - COMPUTE_JOB_FULL_ARTIFACT_RETENTION_DAYS * MILLISECONDS_PER_DAY);
    const tombstoneCutoff = new Date(now.getTime() - COMPUTE_JOB_TOMBSTONE_RETENTION_DAYS * MILLISECONDS_PER_DAY);
    const candidates = await this.pool.query<CandidateOwnerRow>(
      `SELECT usage.owner_user_id
       FROM compute_job_retention_usage usage
       WHERE usage.terminal_artifact_count > $3
          OR usage.terminal_artifact_bytes > $4
          OR usage.tombstone_count > $5
          OR EXISTS (
            SELECT 1 FROM compute_jobs job
            WHERE job.owner_user_id = usage.owner_user_id
              AND job.status IN ('completed', 'failed', 'cancelled')
              AND job.artifacts_pruned_at IS NULL
              AND job.completed_at < $1
          )
          OR EXISTS (
            SELECT 1 FROM compute_jobs job
            WHERE job.owner_user_id = usage.owner_user_id
              AND job.artifacts_pruned_at < $2
          )
       ORDER BY usage.last_retention_at ASC NULLS FIRST, usage.owner_user_id ASC
       LIMIT ${OWNER_SCAN_LIMIT}`,
      [
        artifactCutoff,
        tombstoneCutoff,
        COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER,
        COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER,
        COMPUTE_JOB_TOMBSTONES_PER_OWNER
      ]
    );

    let ownersLocked = 0;
    let artifactsCompacted = 0;
    let tombstonesDeleted = 0;
    for (const candidate of candidates.rows) {
      const used = artifactsCompacted + tombstonesDeleted;
      if (used >= batchLimit) break;
      const result = await this.enforceOwner(
        candidate.owner_user_id,
        artifactCutoff,
        tombstoneCutoff,
        batchLimit - used
      );
      if (result.locked) ownersLocked += 1;
      artifactsCompacted += result.artifactsCompacted;
      tombstonesDeleted += result.tombstonesDeleted;
    }
    return {
      ownersScanned: candidates.rows.length,
      ownersLocked,
      artifactsCompacted,
      tombstonesDeleted,
      batchLimit,
      remainingWorkLikely:
        candidates.rows.length === OWNER_SCAN_LIMIT
        || artifactsCompacted + tombstonesDeleted === batchLimit
    };
  }

  private async enforceOwner(
    ownerUserId: string,
    artifactCutoff: Date,
    tombstoneCutoff: Date,
    limit: number
  ): Promise<{ locked: boolean; artifactsCompacted: number; tombstonesDeleted: number }> {
    return this.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS locked",
        [JOB_ADVISORY_LOCK_NAMESPACE, ownerUserId]
      );
      if (lock.rows[0]?.locked !== true) {
        return { locked: false, artifactsCompacted: 0, tombstonesDeleted: 0 };
      }

      let remaining = limit;
      let artifactsCompacted = await compactExpiredArtifacts(client, ownerUserId, artifactCutoff, remaining);
      remaining -= artifactsCompacted;

      let usage = await readUsage(client, ownerUserId);
      if (remaining > 0) {
        const countExcess = boundedExcess(
          usage.terminalArtifactCount,
          COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER,
          remaining
        );
        if (countExcess > 0) {
          const compacted = await compactOldestArtifacts(client, ownerUserId, countExcess);
          artifactsCompacted += compacted;
          remaining -= compacted;
          usage = await readUsage(client, ownerUserId);
        }
      }
      if (
        remaining > 0
        && usage.terminalArtifactBytes > BigInt(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER)
      ) {
        const compacted = await compactArtifactsForByteExcess(
          client,
          ownerUserId,
          usage.terminalArtifactBytes - BigInt(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER),
          remaining
        );
        artifactsCompacted += compacted;
        remaining -= compacted;
      }

      let tombstonesDeleted = 0;
      if (remaining > 0) {
        tombstonesDeleted = await deleteExpiredTombstones(client, ownerUserId, tombstoneCutoff, remaining);
        remaining -= tombstonesDeleted;
      }
      if (remaining > 0) {
        usage = await readUsage(client, ownerUserId);
        const tombstoneExcess = boundedExcess(
          usage.tombstoneCount,
          COMPUTE_JOB_TOMBSTONES_PER_OWNER,
          remaining
        );
        if (tombstoneExcess > 0) {
          const deleted = await deleteOldestTombstones(client, ownerUserId, tombstoneExcess);
          tombstonesDeleted += deleted;
        }
      }
      await client.query(
        "UPDATE compute_job_retention_usage SET last_retention_at = statement_timestamp() WHERE owner_user_id = $1",
        [ownerUserId]
      );
      return { locked: true, artifactsCompacted, tombstonesDeleted };
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

async function compactExpiredArtifacts(
  client: PoolClient,
  ownerUserId: string,
  cutoff: Date,
  limit: number
): Promise<number> {
  return compactArtifacts(client, ownerUserId, limit, "AND completed_at < $3", [cutoff]);
}

async function compactOldestArtifacts(client: PoolClient, ownerUserId: string, limit: number): Promise<number> {
  return compactArtifacts(client, ownerUserId, limit, "", []);
}

async function compactArtifacts(
  client: PoolClient,
  ownerUserId: string,
  limit: number,
  extraPredicate: string,
  extraValues: readonly unknown[]
): Promise<number> {
  if (limit <= 0) return 0;
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT id
       FROM compute_jobs
       WHERE owner_user_id = $1
         AND status IN ('completed', 'failed', 'cancelled')
         AND artifacts_pruned_at IS NULL
         ${extraPredicate}
       ORDER BY completed_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE compute_jobs job SET
       payload = NULL,
       result = NULL,
       result_ref = NULL,
       error_message = NULL,
       artifact_size_bytes = 0,
       artifacts_pruned_at = statement_timestamp(),
       updated_at = statement_timestamp()
     FROM candidates
     WHERE job.id = candidates.id`,
    [ownerUserId, limit, ...extraValues]
  );
  return result.rowCount ?? 0;
}

async function compactArtifactsForByteExcess(
  client: PoolClient,
  ownerUserId: string,
  excessBytes: bigint,
  limit: number
): Promise<number> {
  const result = await client.query(
    `WITH bounded AS MATERIALIZED (
       SELECT id, completed_at, artifact_size_bytes
       FROM compute_jobs
       WHERE owner_user_id = $1
         AND status IN ('completed', 'failed', 'cancelled')
         AND artifacts_pruned_at IS NULL
       ORDER BY completed_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     ), ranked AS MATERIALIZED (
       SELECT id, artifact_size_bytes,
         COALESCE(sum(artifact_size_bytes) OVER (
           ORDER BY completed_at ASC, id ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS prior_bytes
       FROM bounded
     ), candidates AS MATERIALIZED (
       SELECT id FROM ranked WHERE prior_bytes < $3::bigint
     )
     UPDATE compute_jobs job SET
       payload = NULL,
       result = NULL,
       result_ref = NULL,
       error_message = NULL,
       artifact_size_bytes = 0,
       artifacts_pruned_at = statement_timestamp(),
       updated_at = statement_timestamp()
     FROM candidates
     WHERE job.id = candidates.id`,
    [ownerUserId, limit, excessBytes.toString()]
  );
  return result.rowCount ?? 0;
}

async function deleteExpiredTombstones(
  client: PoolClient,
  ownerUserId: string,
  cutoff: Date,
  limit: number
): Promise<number> {
  return deleteTombstones(client, ownerUserId, limit, "AND artifacts_pruned_at < $3", [cutoff]);
}

async function deleteOldestTombstones(client: PoolClient, ownerUserId: string, limit: number): Promise<number> {
  return deleteTombstones(client, ownerUserId, limit, "", []);
}

async function deleteTombstones(
  client: PoolClient,
  ownerUserId: string,
  limit: number,
  extraPredicate: string,
  extraValues: readonly unknown[]
): Promise<number> {
  if (limit <= 0) return 0;
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT id
       FROM compute_jobs
       WHERE owner_user_id = $1
         AND artifacts_pruned_at IS NOT NULL
         ${extraPredicate}
       ORDER BY artifacts_pruned_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     DELETE FROM compute_jobs job
     USING candidates
     WHERE job.id = candidates.id`,
    [ownerUserId, limit, ...extraValues]
  );
  return result.rowCount ?? 0;
}

async function readUsage(client: PoolClient, ownerUserId: string): Promise<RetentionUsage> {
  const result = await client.query<UsageRow>(
    `SELECT terminal_artifact_count::text, terminal_artifact_bytes::text, tombstone_count::text
     FROM compute_job_retention_usage
     WHERE owner_user_id = $1
     FOR UPDATE`,
    [ownerUserId]
  );
  const row = result.rows[0];
  return {
    terminalArtifactCount: BigInt(row?.terminal_artifact_count ?? 0),
    terminalArtifactBytes: BigInt(row?.terminal_artifact_bytes ?? 0),
    tombstoneCount: BigInt(row?.tombstone_count ?? 0)
  };
}

function boundedExcess(value: bigint, maximum: number, remaining: number): number {
  const excess = value - BigInt(maximum);
  if (excess <= 0n) return 0;
  return Number(excess > BigInt(remaining) ? BigInt(remaining) : excess);
}
