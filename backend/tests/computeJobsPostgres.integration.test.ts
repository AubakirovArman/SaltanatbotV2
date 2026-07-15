import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import {
  ComputeJobRepository,
  JobIdempotencyConflictError,
  JobQuotaError
} from "../src/jobs/repository.js";
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
    await pool.query("TRUNCATE compute_jobs");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("never claims two running jobs for one owner under concurrent workers", async () => {
    await enqueue(OWNER_A, "owner-a-1");
    await enqueue(OWNER_A, "owner-a-2");
    await enqueue(OWNER_B, "owner-b-1");

    await Promise.all([
      repository.claim("worker-a", 30_000),
      repository.claim("worker-b", 30_000)
    ]);
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
