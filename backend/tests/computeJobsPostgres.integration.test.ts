import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { PostgresIdentityRepository } from "../src/identity/postgresRepository.js";
import { COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER, COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER, COMPUTE_JOB_TOMBSTONES_PER_OWNER, ComputeJobArtifactRetention } from "../src/jobs/artifactRetention.js";
import { ComputeJobRepository, JobIdempotencyConflictError, JobQuotaError } from "../src/jobs/repository.js";
import { MAX_COMPUTE_JOB_RESULT_BYTES } from "../src/jobs/resultPayload.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000011";
const OWNER_B = "00000000-0000-4000-8000-000000000012";
let pool: Pool;
let repository: ComputeJobRepository;

describePostgres("compute jobs against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "JOBS_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'job-owner-a', 'job-owner-a', $3, 'active'),
              ($2, 'job-owner-b', 'job-owner-b', $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, "test-password-hash-placeholder"]
    );
    repository = new ComputeJobRepository(pool);
  });

  beforeEach(async () => {
    // ga_runs.job_id references compute_jobs since schema 17, so the queue
    // truncation must cascade through the lineage tables.
    await pool.query("TRUNCATE compute_jobs, compute_job_retention_usage CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("never claims two running jobs for one owner under concurrent workers", async () => {
    await enqueue(OWNER_A, "owner-a-1");
    await enqueue(OWNER_A, "owner-a-2");
    await enqueue(OWNER_B, "owner-b-1");

    await Promise.all([repository.claim("worker-a", 30_000), repository.claim("worker-b", 30_000)]);
    await repository.claim("worker-c", 30_000);

    const running = await pool.query<{ owner_user_id: string; count: string }>(
      `SELECT owner_user_id::text, count(*)::text AS count
       FROM compute_jobs WHERE status = 'running' GROUP BY owner_user_id ORDER BY owner_user_id`
    );
    expect(running.rows).toEqual([
      { owner_user_id: OWNER_A, count: "1" },
      { owner_user_id: OWNER_B, count: "1" }
    ]);
  });

  it("never claims queued work for a disabled owner", async () => {
    const disabled = await enqueue(OWNER_A, "disabled-owner-job");
    const active = await enqueue(OWNER_B, "active-owner-job");
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [OWNER_A]);

    try {
      const claimed = await repository.claim("worker-active-only", 30_000);
      expect(claimed?.id).toBe(active.id);
      expect(await repository.get(OWNER_A, disabled.id)).toMatchObject({
        id: disabled.id,
        status: "queued"
      });
    } finally {
      await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [OWNER_A]);
    }
  });

  it("advances the durable authorization revision only for authorization changes", async () => {
    const identities = new PostgresIdentityRepository(pool);
    const before = await identities.findUserById(OWNER_A);
    expect(before).toBeDefined();

    const changed = await identities.updateUser(OWNER_A, {
      tradingRole: before!.tradingRole === "read-only" ? "paper-trade" : "read-only",
      updatedAt: new Date()
    });
    expect(changed?.authorizationRevision).toBe(before!.authorizationRevision + 1);

    const touched = await identities.updateUser(OWNER_A, {
      lastLoginAt: new Date(),
      updatedAt: new Date()
    });
    expect(touched?.authorizationRevision).toBe(changed!.authorizationRevision);
  });

  it("rotates an owner's backlog behind another ready owner", async () => {
    const ownerAFirst = await enqueue(OWNER_A, "fair-owner-a-1");
    const ownerASecond = await enqueue(OWNER_A, "fair-owner-a-2");
    const ownerBFirst = await enqueue(OWNER_B, "fair-owner-b-1");
    await pool.query(
      `UPDATE compute_jobs SET run_after = CASE id
         WHEN $1 THEN clock_timestamp() - interval '3 minutes'
         WHEN $2 THEN clock_timestamp() - interval '2 minutes'
         WHEN $3 THEN clock_timestamp() - interval '1 minute'
         ELSE run_after END
       WHERE id IN ($1, $2, $3)`,
      [ownerAFirst.id, ownerASecond.id, ownerBFirst.id]
    );

    const first = await repository.claim("worker-a", 30_000);
    expect(first?.id).toBe(ownerAFirst.id);
    await repository.complete(first!.id, first!.leaseToken, { sequence: 1 });

    const second = await repository.claim("worker-b", 30_000);
    expect(second?.id).toBe(ownerBFirst.id);
    await repository.complete(second!.id, second!.leaseToken, { sequence: 2 });

    const third = await repository.claim("worker-c", 30_000);
    expect(third?.id).toBe(ownerASecond.id);
  });

  it("reports isolated owner metrics and aggregate worker metrics", async () => {
    const completed = await enqueue(OWNER_A, "metrics-completed");
    await enqueue(OWNER_A, "metrics-queued");
    const claim = await repository.claim("worker-metrics", 30_000);
    expect(claim?.id).toBe(completed.id);
    await repository.complete(claim!.id, claim!.leaseToken, { ok: true });
    await enqueue(OWNER_B, "metrics-other-owner");

    const ownerMetrics = await repository.getOwnerMetrics(OWNER_A);
    expect(ownerMetrics).toMatchObject({
      queueDepth: 1,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      durationSeconds: { samples: 1 }
    });
    expect(ownerMetrics.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(ownerMetrics.durationSeconds.average).toBeGreaterThanOrEqual(0);
    expect(ownerMetrics.durationSeconds.p95).toBeGreaterThanOrEqual(0);

    await expect(repository.getOwnerMetrics(OWNER_B)).resolves.toMatchObject({
      queueDepth: 1,
      completed: 0,
      durationSeconds: { samples: 0 }
    });
    await expect(repository.getAggregateMetrics()).resolves.toMatchObject({
      queueDepth: 2,
      completed: 1,
      durationSeconds: { samples: 1 }
    });
  });

  it("keeps the stable metrics cutoff indexable", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         WITH metric_clock AS MATERIALIZED (
           SELECT statement_timestamp() - interval '24 hours' AS terminal_cutoff
         )
         SELECT status, completed_at
         FROM compute_jobs
         WHERE owner_user_id = $1
           AND status IN ('completed', 'failed', 'cancelled')
           AND completed_at >= (SELECT terminal_cutoff FROM metric_clock)
         ORDER BY completed_at DESC
         LIMIT 10001`,
        [OWNER_A]
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("compute_jobs_owner_terminal_completed_index");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("compacts old terminal artifacts without touching active jobs or losing exact-request idempotency", async () => {
    const old = await enqueue(OWNER_A, "retention-old", "retention-request-old");
    const claimed = await repository.claim("worker-retention", 30_000);
    expect(claimed?.id).toBe(old.id);
    await repository.complete(old.id, claimed!.leaseToken, { retainedUntilExpiry: true });
    await pool.query("UPDATE compute_jobs SET completed_at = $2, updated_at = $2 WHERE id = $1", [old.id, new Date("2026-05-01T00:00:00.000Z")]);
    const active = await enqueue(OWNER_A, "retention-active", "retention-request-active");

    const retention = new ComputeJobArtifactRetention(pool);
    await expect(retention.enforce(new Date("2026-07-16T00:00:00.000Z"))).resolves.toMatchObject({
      artifactsCompacted: 1,
      tombstonesDeleted: 0
    });

    const tombstone = await repository.get(OWNER_A, old.id);
    expect(tombstone).toMatchObject({
      id: old.id,
      status: "completed",
      artifactsExpired: true,
      errorMessage: undefined
    });
    expect(tombstone).not.toHaveProperty("payload");
    expect(tombstone).not.toHaveProperty("result");
    expect(await repository.get(OWNER_A, active.id)).toMatchObject({
      id: active.id,
      status: "queued",
      artifactsExpired: false,
      payload: { kind: "backtest", key: "retention-active" }
    });

    await expect(enqueue(OWNER_A, "retention-old", "retention-request-old")).resolves.toMatchObject({
      id: old.id,
      artifactsExpired: true
    });
    await expect(enqueue(OWNER_A, "different-content", "retention-request-old")).rejects.toBeInstanceOf(JobIdempotencyConflictError);
    await expect(enqueue(OWNER_A, "retention-old", "retention-request-new")).resolves.not.toMatchObject({
      id: old.id
    });
  });

  it("keeps distinct exact request IDs honest across content matches and compaction", async () => {
    const requestA = await enqueue(OWNER_A, "same-content", "exact-request-a");
    const requestB = await enqueue(OWNER_A, "same-content", "exact-request-b");
    expect(requestB.id).not.toBe(requestA.id);

    const claimA = await repository.claim("worker-exact-a", 30_000);
    expect(claimA?.id).toBe(requestA.id);
    await repository.complete(claimA!.id, claimA!.leaseToken, { request: "a" });
    const claimB = await repository.claim("worker-exact-b", 30_000);
    expect(claimB?.id).toBe(requestB.id);
    await repository.complete(claimB!.id, claimB!.leaseToken, { request: "b" });

    await pool.query(
      `UPDATE compute_jobs
       SET completed_at = $2, updated_at = $2
       WHERE id = ANY($1::uuid[])`,
      [[requestA.id, requestB.id], new Date("2026-05-01T00:00:00.000Z")]
    );
    await expect(new ComputeJobArtifactRetention(pool).enforce(new Date("2026-07-16T00:00:00.000Z"))).resolves.toMatchObject({ artifactsCompacted: 2 });

    await expect(enqueue(OWNER_A, "same-content", "exact-request-b")).resolves.toMatchObject({
      id: requestB.id,
      artifactsExpired: true
    });
  });

  it("normalizes schema-valid legacy terminal timestamps while migrating from v7", async () => {
    const schemaName = `retention_migration_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION CURRENT_USER`);
    const migrationPool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schemaName}`
    });
    const legacyOwner = "00000000-0000-4000-8000-000000000019";
    const legacyJob = "00000000-0000-4000-8000-000000000029";
    const legacyTimestamp = new Date("2026-04-01T00:00:00.000Z");

    try {
      await migrateDatabase(migrationPool, { migrations: DATABASE_MIGRATIONS.slice(0, 7) });
      await migrationPool.query(
        `INSERT INTO users (id, login, login_normalized, password_hash, status)
         VALUES ($1, 'legacy-retention-owner', 'legacy-retention-owner', $2, 'active')`,
        [legacyOwner, "test-password-hash-placeholder"]
      );
      await migrationPool.query(
        `INSERT INTO compute_jobs (
           id, owner_user_id, job_type, status, payload, progress, estimated_cost,
           attempt, max_attempts, created_at, updated_at
         ) VALUES ($1, $2, 'backtest', 'completed', '{}'::jsonb, 1, 1, 1, 2, $3, $3)`,
        [legacyJob, legacyOwner, legacyTimestamp]
      );

      await expect(
        migrateDatabase(migrationPool, {
          migrations: DATABASE_MIGRATIONS.slice(0, 8)
        })
      ).resolves.toMatchObject({
        fromVersion: 7,
        toVersion: 8,
        applied: [{ version: 8, name: "bounded_compute_job_artifact_retention" }]
      });
      const normalized = await migrationPool.query<{ completed_at: Date }>("SELECT completed_at FROM compute_jobs WHERE id = $1", [legacyJob]);
      expect(normalized.rows[0]?.completed_at.toISOString()).toBe(legacyTimestamp.toISOString());
      await expect(
        migrationPool.query(
          `INSERT INTO compute_jobs (
             id, owner_user_id, job_type, status, payload, artifact_size_bytes,
             progress, estimated_cost, attempt, max_attempts
           ) VALUES ($1, $2, 'backtest', 'failed', '{}'::jsonb, 2, 1, 1, 1, 2)`,
          ["00000000-0000-4000-8000-000000000039", legacyOwner]
        )
      ).rejects.toMatchObject({ constraint: "compute_jobs_terminal_completed_at" });
    } finally {
      await migrationPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    }
  });

  it("enforces exact per-owner terminal count, byte and tombstone caps in bounded batches", async () => {
    await insertTerminalJobs(OWNER_A, COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER + 1, "count-cap");
    await insertTerminalJobs(OWNER_B, 2, "byte-cap");
    await pool.query(
      `UPDATE compute_jobs
       SET artifact_size_bytes = $2
       WHERE owner_user_id = $1`,
      [OWNER_B, 200 * 1024 * 1024]
    );

    const retention = new ComputeJobArtifactRetention(pool);
    const compacted = await retention.enforce(new Date("2026-07-16T00:00:00.000Z"));
    expect(compacted.artifactsCompacted).toBe(2);
    expect(compacted.artifactsCompacted + compacted.tombstonesDeleted).toBeLessThanOrEqual(50);

    const usage = await pool.query<{
      owner_user_id: string;
      terminal_artifact_count: string;
      terminal_artifact_bytes: string;
      tombstone_count: string;
    }>(
      `SELECT owner_user_id::text, terminal_artifact_count::text,
         terminal_artifact_bytes::text, tombstone_count::text
       FROM compute_job_retention_usage
       WHERE owner_user_id = ANY($1::uuid[])
       ORDER BY owner_user_id`,
      [[OWNER_A, OWNER_B]]
    );
    expect(usage.rows).toEqual([
      {
        owner_user_id: OWNER_A,
        terminal_artifact_count: String(COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER),
        terminal_artifact_bytes: String(COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER * 2),
        tombstone_count: "1"
      },
      {
        owner_user_id: OWNER_B,
        terminal_artifact_count: "1",
        terminal_artifact_bytes: String(200 * 1024 * 1024),
        tombstone_count: "1"
      }
    ]);
    expect(BigInt(usage.rows[1]!.terminal_artifact_bytes)).toBeLessThanOrEqual(BigInt(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER));
  });

  it("deletes only the oldest compact tombstone above the per-owner cap", async () => {
    await pool.query(
      `INSERT INTO compute_jobs (
         id, owner_user_id, job_type, status, payload, artifact_size_bytes,
         progress, estimated_cost, attempt, max_attempts, completed_at,
         created_at, updated_at, artifacts_pruned_at
       )
       SELECT
         md5('tombstone-cap-' || sequence::text)::uuid,
         $1,
         'backtest',
         'completed',
         NULL,
         0,
         1,
         1,
         1,
         2,
         $2::timestamptz,
         $2::timestamptz,
         $2::timestamptz,
         $2::timestamptz + (sequence * interval '1 millisecond')
       FROM generate_series(1, $3) AS sequence`,
      [OWNER_A, new Date("2026-07-15T00:00:00.000Z"), COMPUTE_JOB_TOMBSTONES_PER_OWNER + 1]
    );

    const retention = new ComputeJobArtifactRetention(pool);
    await expect(retention.enforce(new Date("2026-07-16T00:00:00.000Z"))).resolves.toMatchObject({
      artifactsCompacted: 0,
      tombstonesDeleted: 1
    });
    const usage = await pool.query<{ tombstone_count: string }>("SELECT tombstone_count::text FROM compute_job_retention_usage WHERE owner_user_id = $1", [OWNER_A]);
    expect(usage.rows[0]?.tombstone_count).toBe(String(COMPUTE_JOB_TOMBSTONES_PER_OWNER));
  });

  it("keeps a recent tombstone but deletes one beyond the 90-day horizon", async () => {
    await pool.query(
      `INSERT INTO compute_jobs (
         id, owner_user_id, job_type, status, payload, artifact_size_bytes,
         progress, estimated_cost, attempt, max_attempts, completed_at,
         created_at, updated_at, artifacts_pruned_at
       ) VALUES
         ($1, $3, 'backtest', 'completed', NULL, 0, 1, 1, 1, 2, $4, $4, $4, $5),
         ($2, $3, 'backtest', 'completed', NULL, 0, 1, 1, 1, 2, $4, $4, $4, $6)`,
      ["00000000-0000-4000-8000-000000000041", "00000000-0000-4000-8000-000000000042", OWNER_A, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"), new Date("2026-07-15T00:00:00.000Z")]
    );

    const retention = new ComputeJobArtifactRetention(pool);
    await expect(retention.enforce(new Date("2026-07-16T00:00:00.000Z"))).resolves.toMatchObject({
      artifactsCompacted: 0,
      tombstonesDeleted: 1
    });
    await expect(repository.get(OWNER_A, "00000000-0000-4000-8000-000000000041")).resolves.toBeUndefined();
    await expect(repository.get(OWNER_A, "00000000-0000-4000-8000-000000000042")).resolves.toMatchObject({
      artifactsExpired: true
    });
  });

  it("lets cancellation atomically beat a late successful result", async () => {
    const queued = await enqueue(OWNER_A, "cancel-race");
    const claimed = await repository.claim("worker-a", 30_000);
    expect(claimed?.id).toBe(queued.id);

    await repository.cancel(OWNER_A, queued.id);
    await repository.complete(queued.id, claimed!.leaseToken, { shouldNotPersist: true });

    const stored = await repository.get(OWNER_A, queued.id);
    expect(stored).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(stored).not.toHaveProperty("result");
  });

  it("stores a bounded failure instead of an oversized result", async () => {
    const queued = await enqueue(OWNER_A, "oversized-result");
    const claimed = await repository.claim("worker-a", 30_000);
    expect(claimed?.id).toBe(queued.id);

    await expect(
      repository.complete(queued.id, claimed!.leaseToken, {
        value: "x".repeat(MAX_COMPUTE_JOB_RESULT_BYTES + 1)
      })
    ).resolves.toBe(true);

    const stored = await repository.get(OWNER_A, queued.id);
    expect(stored).toMatchObject({ status: "failed", errorCode: "result_too_large" });
    expect(stored).not.toHaveProperty("result");
  });

  it("requeues clean shutdowns immediately without consuming an attempt", async () => {
    const queued = await enqueue(OWNER_A, "shutdown-requeue");
    const first = await repository.claim("worker-a", 30_000);
    expect(first).toMatchObject({ id: queued.id, attempt: 1 });

    await repository.requeueForShutdown(queued.id, first!.leaseToken);
    const second = await repository.claim("worker-b", 30_000);

    expect(second).toMatchObject({ id: queued.id, attempt: 1, status: "running" });
  });

  it("recovers an expired lease once and fails it after the final attempt", async () => {
    const queued = await enqueue(OWNER_A, "lease-recovery");
    const first = await repository.claim("worker-a", 30_000);
    await expireLease(queued.id);

    await expect(repository.recoverExpiredLeases()).resolves.toBe(1);
    expect(await repository.get(OWNER_A, queued.id)).toMatchObject({ status: "queued", progress: 0, attempt: 1 });

    await pool.query("UPDATE compute_jobs SET run_after = clock_timestamp() WHERE id = $1", [queued.id]);
    const second = await repository.claim("worker-b", 30_000);
    expect(second).toMatchObject({ attempt: 2 });
    await expireLease(queued.id);
    await expect(repository.recoverExpiredLeases()).resolves.toBe(1);
    expect(await repository.get(OWNER_A, queued.id)).toMatchObject({
      status: "failed",
      errorCode: "worker_lease_expired",
      attempt: 2
    });
  });

  it("rejects every stale lease operation and leaves recovery authoritative", async () => {
    const queued = await enqueue(OWNER_A, "stale-lease-operations");
    const claimed = await repository.claim("worker-a", 30_000);
    expect(claimed?.id).toBe(queued.id);
    await expireLease(queued.id);

    await expect(repository.heartbeat(queued.id, claimed!.leaseToken, 30_000, 0.5)).resolves.toBe(false);
    await expect(repository.cancellationRequested(queued.id, claimed!.leaseToken)).resolves.toBe(true);
    await expect(repository.complete(queued.id, claimed!.leaseToken, { stale: true })).resolves.toBe(false);
    await expect(repository.fail(queued.id, claimed!.leaseToken, "stale", "stale failure")).resolves.toBe(false);
    await expect(repository.retryOrFail(queued.id, claimed!.leaseToken, "worker_exit", "stale retry")).resolves.toBe(false);
    await expect(repository.requeueForShutdown(queued.id, claimed!.leaseToken)).resolves.toBe(false);

    await expect(repository.recoverExpiredLeases()).resolves.toBe(1);
    expect(await repository.get(OWNER_A, queued.id)).toMatchObject({ status: "queued", attempt: 1 });
  });

  it("backs off a transient failure and fails it after the final attempt", async () => {
    const queued = await enqueue(OWNER_A, "transient-retry");
    const first = await repository.claim("worker-a", 30_000);
    expect(first?.id).toBe(queued.id);

    await expect(repository.retryOrFail(queued.id, first!.leaseToken, "worker_exit", "first crash")).resolves.toBe(true);
    const delayed = await pool.query<{ delayed: boolean; error_code: string | null }>("SELECT run_after > clock_timestamp() AS delayed, error_code FROM compute_jobs WHERE id = $1", [queued.id]);
    expect(delayed.rows[0]).toEqual({ delayed: true, error_code: "worker_exit" });
    expect(await repository.get(OWNER_A, queued.id)).toMatchObject({ status: "queued", attempt: 1 });

    await pool.query("UPDATE compute_jobs SET run_after = clock_timestamp() WHERE id = $1", [queued.id]);
    const second = await repository.claim("worker-b", 30_000);
    expect(second).toMatchObject({ id: queued.id, attempt: 2, errorCode: undefined });
    await expect(repository.retryOrFail(queued.id, second!.leaseToken, "worker_exit", "second crash")).resolves.toBe(true);
    expect(await repository.get(OWNER_A, queued.id)).toMatchObject({
      status: "failed",
      attempt: 2,
      errorCode: "worker_exit"
    });
  });

  it("keeps duplicate retries idempotent even at quota and rejects conflicting request IDs", async () => {
    const first = await enqueue(OWNER_A, "quota-1", "request-quota-1");
    for (let index = 2; index <= 5; index += 1) await enqueue(OWNER_A, `quota-${index}`, `request-quota-${index}`);

    await expect(enqueue(OWNER_A, "quota-1", "request-quota-1")).resolves.toMatchObject({ id: first.id });
    await expect(enqueue(OWNER_A, "quota-6", "request-quota-6")).rejects.toBeInstanceOf(JobQuotaError);
    await expect(enqueue(OWNER_A, "different-content", "request-quota-1")).rejects.toBeInstanceOf(JobIdempotencyConflictError);
  });
});

function enqueue(ownerUserId: string, dedupeKey: string, clientRequestId = randomUUID()) {
  return repository.enqueue({
    ownerUserId,
    jobType: "backtest",
    payload: { kind: "backtest", key: dedupeKey },
    estimatedCost: 10,
    clientRequestId,
    dedupeKey
  });
}

async function expireLease(id: string): Promise<void> {
  await pool.query("UPDATE compute_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
}

async function insertTerminalJobs(ownerUserId: string, count: number, prefix: string): Promise<void> {
  await pool.query(
    `INSERT INTO compute_jobs (
       id, owner_user_id, job_type, status, payload, artifact_size_bytes,
       progress, estimated_cost, attempt, max_attempts, completed_at, created_at, updated_at
     )
     SELECT
       md5($2 || '-' || sequence::text)::uuid,
       $1,
       'backtest',
       'completed',
       '{}'::jsonb,
       2,
       1,
       1,
       1,
       2,
       $3,
       $3,
       $3
     FROM generate_series(1, $4) AS sequence`,
    [ownerUserId, prefix, new Date("2026-07-15T00:00:00.000Z"), count]
  );
}
