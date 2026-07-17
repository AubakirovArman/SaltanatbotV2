import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresExecutorCommandRepository } from "../src/database/executorCommands.js";
import {
  ExecutorCommandCapacityError,
  ExecutorCommandIdempotencyConflictError,
  MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES,
  type EnqueueExecutorCommandInput
} from "../src/database/executorCommandTypes.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString =
  process.env.EXECUTOR_COMMANDS_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000071";
const OWNER_B = "00000000-0000-4000-8000-000000000072";
const ACTOR = "00000000-0000-4000-8000-000000000073";
let pool: Pool;
let repository: PostgresExecutorCommandRepository;

describePostgres("executor commands against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 16 });
    await assertIsolatedTestDatabase(
      pool,
      process.env.EXECUTOR_COMMANDS_TEST_DATABASE_URL
        ? "EXECUTOR_COMMANDS_TEST_DATABASE_URL"
        : "JOBS_TEST_DATABASE_URL"
    );
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES
         ($1, 'executor-owner-a', 'executor-owner-a', $4, 'active'),
         ($2, 'executor-owner-b', 'executor-owner-b', $4, 'active'),
         ($3, 'executor-actor', 'executor-actor', $4, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, ACTOR, "test-auth-hash-placeholder"]
    );
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE executor_commands");
    repository = new PostgresExecutorCommandRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("installs the bounded queue, fencing and retention indexes in schema v12", async () => {
    const columns = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'executor_commands'
       ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "owner_user_id",
      "actor_user_id",
      "session_id_hash",
      "authorization_revision",
      "authorization_epoch",
      "command_type",
      "target_type",
      "target_id",
      "idempotency_key",
      "request_hash",
      "payload",
      "status",
      "attempt",
      "max_attempts",
      "lease_generation",
      "lease_owner",
      "lease_token",
      "lease_acquired_at",
      "lease_expires_at",
      "sqlite_receipt_hash",
      "result",
      "error_code",
      "error_message",
      "created_at",
      "updated_at",
      "terminal_at",
      "applied_at"
    ]);
    expect(columns.rows.map((row) => row.column_name).join(" ")).not.toMatch(
      /password|api_key|private_key|exchange_secret|signed_request/i
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename = 'executor_commands'
       ORDER BY indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "executor_commands_expired_lease_index",
        "executor_commands_one_applying_per_owner",
        "executor_commands_owner_status_recent_index",
        "executor_commands_owner_target_recent_index",
        "executor_commands_owner_terminal_retention_index",
        "executor_commands_queue_claim_index",
        "executor_commands_owner_user_id_idempotency_key_key"
      ])
    );
  });

  it("upgrades an existing schema v11 atomically without changing its users", async () => {
    const schemaName = `executor_v12_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION CURRENT_USER`);
    const migrationPool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path=${schemaName}`
    });
    const legacyOwner = "00000000-0000-4000-8000-000000000079";
    try {
      await migrateDatabase(migrationPool, { migrations: DATABASE_MIGRATIONS.slice(0, 11) });
      await migrationPool.query(
        `INSERT INTO users (id, login, login_normalized, password_hash, status)
         VALUES ($1, 'executor-v11-owner', 'executor-v11-owner', $2, 'active')`,
        [legacyOwner, "test-auth-hash-placeholder"]
      );

      await expect(migrateDatabase(migrationPool)).resolves.toMatchObject({
        fromVersion: 11,
        toVersion: 12,
        applied: [{ version: 12, name: "durable_executor_command_queue" }]
      });
      const proof = await migrationPool.query<{ users: string; commands: string }>(
        `SELECT
           (SELECT count(*)::text FROM users WHERE id = $1) AS users,
           (SELECT count(*)::text FROM executor_commands) AS commands`,
        [legacyOwner]
      );
      expect(proof.rows[0]).toEqual({ users: "1", commands: "0" });
    } finally {
      await migrationPool.end();
      await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
    }
  });

  it("atomically replays one owner-scoped Idempotency-Key and conflicts on another hash", async () => {
    const input = commandInput();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => repository.enqueue(input))
    );

    expect(outcomes.filter((outcome) => outcome.outcome === "enqueued")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "replayed")).toHaveLength(11);
    expect(new Set(outcomes.map((outcome) => outcome.command.id))).toHaveLength(1);
    await expect(
      repository.enqueue(commandInput({ requestHash: digest("different-request") }))
    ).rejects.toBeInstanceOf(ExecutorCommandIdempotencyConflictError);
    await expect(repository.enqueue(commandInput({ ownerUserId: OWNER_B }))).resolves.toMatchObject({
      outcome: "enqueued",
      command: { ownerUserId: OWNER_B }
    });
  });

  it("enforces authorization and JSON byte caps inside PostgreSQL", async () => {
    const queued = await repository.enqueue(commandInput({ authorizationEpoch: 0 }));
    await expect(
      pool.query("UPDATE executor_commands SET authorization_epoch = -1 WHERE id = $1", [
        queued.command.id
      ])
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE executor_commands SET payload = $2::jsonb WHERE id = $1", [
        queued.command.id,
        JSON.stringify({ value: "x".repeat(MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES) })
      ])
    ).rejects.toMatchObject({ code: "23514" });
    await expect(repository.get(OWNER_A, queued.command.id)).resolves.toMatchObject({
      authorizationEpoch: 0,
      payload: { requestedState: "running", executionMode: "paper" }
    });
  });

  it("enforces the active owner cap after replay lookup and keeps reads tenant-scoped", async () => {
    repository = new PostgresExecutorCommandRepository(pool, { maxActivePerOwner: 2 });
    const first = await repository.enqueue(commandInput());
    const second = await repository.enqueue(
      commandInput({
        idempotencyKey: "command:2",
        requestHash: digest("request-2"),
        targetId: "paper-bot:2"
      })
    );

    await expect(repository.enqueue(commandInput())).resolves.toMatchObject({
      outcome: "replayed",
      command: { id: first.command.id }
    });
    await expect(
      repository.enqueue(
        commandInput({
          idempotencyKey: "command:3",
          requestHash: digest("request-3"),
          targetId: "paper-bot:3"
        })
      )
    ).rejects.toBeInstanceOf(ExecutorCommandCapacityError);
    await expect(repository.get(OWNER_B, first.command.id)).resolves.toBeUndefined();
    await expect(repository.list(OWNER_A)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.command.id }),
        expect.objectContaining({ id: second.command.id })
      ])
    );
    await expect(repository.list(OWNER_B)).resolves.toEqual([]);
  });

  it("uses owner locking so concurrent claims never apply two commands for one owner", async () => {
    await repository.enqueue(commandInput());
    await repository.enqueue(
      commandInput({
        idempotencyKey: "same-owner:2",
        requestHash: digest("same-owner:2"),
        targetId: "paper-bot:2"
      })
    );

    const concurrent = await Promise.all([
      repository.claim("executor-a", 30_000),
      repository.claim("executor-b", 30_000)
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    const applying = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM executor_commands
       WHERE owner_user_id = $1 AND status = 'applying'`,
      [OWNER_A]
    );
    expect(applying.rows[0]?.count).toBe("1");

    await repository.enqueue(commandInput({ ownerUserId: OWNER_B }));
    await expect(repository.claim("executor-c", 30_000)).resolves.toMatchObject({
      ownerUserId: OWNER_B,
      status: "applying"
    });
  });

  it("reclaims an expired fence and acknowledges an existing SQLite receipt without reapply", async () => {
    const queued = await repository.enqueue(commandInput());
    const first = await repository.claim("executor-first", 30_000);
    expect(first?.id).toBe(queued.command.id);
    await expireLease(first!.id);

    const reclaimed = await repository.claim("executor-recovery", 30_000);
    expect(reclaimed).toMatchObject({
      id: first!.id,
      attempt: 2,
      leaseGeneration: 2,
      status: "applying"
    });
    expect(reclaimed!.leaseToken).not.toBe(first!.leaseToken);
    const sqliteReceiptHash = digest("sqlite-command-receipt");
    await expect(
      repository.acknowledgeApplied({
        commandId: first!.id,
        leaseToken: first!.leaseToken,
        leaseGeneration: first!.leaseGeneration,
        sqliteReceiptHash
      })
    ).resolves.toEqual({ outcome: "stale-fence" });

    const acknowledged = await repository.acknowledgeApplied({
      commandId: reclaimed!.id,
      leaseToken: reclaimed!.leaseToken,
      leaseGeneration: reclaimed!.leaseGeneration,
      sqliteReceiptHash,
      result: { recoveredFromSqliteReceipt: true }
    });
    expect(acknowledged).toMatchObject({
      outcome: "acknowledged",
      command: {
        status: "applied",
        sqliteReceiptHash,
        result: { recoveredFromSqliteReceipt: true }
      }
    });
    await expect(
      repository.acknowledgeApplied({
        commandId: reclaimed!.id,
        leaseToken: reclaimed!.leaseToken,
        leaseGeneration: reclaimed!.leaseGeneration,
        sqliteReceiptHash
      })
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      repository.acknowledgeApplied({
        commandId: reclaimed!.id,
        leaseToken: reclaimed!.leaseToken,
        leaseGeneration: reclaimed!.leaseGeneration,
        sqliteReceiptHash: digest("different-receipt")
      })
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("renews only the current live fence and acknowledges bounded rejection idempotently", async () => {
    await repository.enqueue(commandInput());
    const claimed = await repository.claim("executor-reject", 5_000);
    expect(claimed).toBeDefined();
    await expect(
      repository.renewLease({
        commandId: claimed!.id,
        leaseToken: claimed!.leaseToken,
        leaseGeneration: claimed!.leaseGeneration
      })
    ).resolves.toBe(true);
    await expect(
      repository.renewLease({
        commandId: claimed!.id,
        leaseToken: claimed!.leaseToken,
        leaseGeneration: claimed!.leaseGeneration + 1
      })
    ).resolves.toBe(false);

    const rejection = {
      commandId: claimed!.id,
      leaseToken: claimed!.leaseToken,
      leaseGeneration: claimed!.leaseGeneration,
      errorCode: "authorization.revoked",
      errorMessage: "The authorization revision changed before application."
    };
    await expect(repository.acknowledgeRejected(rejection)).resolves.toMatchObject({
      outcome: "acknowledged",
      command: { status: "rejected", errorCode: "authorization.revoked" }
    });
    await expect(repository.acknowledgeRejected(rejection)).resolves.toMatchObject({
      outcome: "duplicate"
    });
    await expect(
      repository.acknowledgeRejected({ ...rejection, errorCode: "target.missing" })
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("terminalizes an expired command after its hard attempt limit", async () => {
    repository = new PostgresExecutorCommandRepository(pool, { maxAttempts: 1 });
    const queued = await repository.enqueue(commandInput());
    const claimed = await repository.claim("executor-once", 30_000);
    expect(claimed?.id).toBe(queued.command.id);
    await expireLease(claimed!.id);

    await expect(repository.recoverExpiredLeases()).resolves.toBe(1);
    await expect(repository.get(OWNER_A, claimed!.id)).resolves.toMatchObject({
      status: "rejected",
      attempt: 1,
      maxAttempts: 1,
      errorCode: "executor_attempts_exhausted"
    });
    await expect(repository.claim("executor-too-late", 30_000)).resolves.toBeUndefined();
  });

  it("prunes terminal commands by owner-local count and age in bounded batches", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await repository.enqueue(
        commandInput({
          idempotencyKey: `terminal:${index}`,
          requestHash: digest(`terminal:${index}`),
          targetId: `paper-bot:${index}`
        })
      );
      const claimed = await repository.claim(`executor-terminal-${index}`, 30_000);
      if (!claimed) throw new Error("expected an executor command claim");
      await repository.acknowledgeApplied({
        commandId: claimed.id,
        leaseToken: claimed.leaseToken,
        leaseGeneration: claimed.leaseGeneration,
        sqliteReceiptHash: digest(`receipt:${index}`)
      });
    }

    repository = new PostgresExecutorCommandRepository(pool, {
      terminalRetentionMs: 1_000,
      maxTerminalPerOwner: 2,
      pruneBatchSize: 10
    });
    await expect(repository.pruneOwner(OWNER_A)).resolves.toEqual({
      deletedByAge: 0,
      deletedByCount: 2
    });
    await pool.query(
      `WITH history AS MATERIALIZED (
         SELECT
           clock_timestamp() - interval '4 seconds' AS created_at,
           clock_timestamp() - interval '2 seconds' AS terminal_at
       )
       UPDATE executor_commands SET
         created_at = history.created_at,
         updated_at = history.terminal_at,
         terminal_at = history.terminal_at,
         applied_at = history.terminal_at
       FROM history
       WHERE owner_user_id = $1`,
      [OWNER_A]
    );
    await expect(repository.pruneOwner(OWNER_A)).resolves.toEqual({
      deletedByAge: 2,
      deletedByCount: 0
    });
    await expect(repository.list(OWNER_A)).resolves.toEqual([]);
  });
});

function commandInput(
  overrides: Partial<EnqueueExecutorCommandInput> = {}
): EnqueueExecutorCommandInput {
  return {
    ownerUserId: OWNER_A,
    actorUserId: ACTOR,
    sessionIdHash: digest("executor-session"),
    authorizationRevision: 4,
    authorizationEpoch: 5,
    commandType: "paper.bot.start",
    targetType: "bot",
    targetId: "paper-bot:1",
    idempotencyKey: "command:1",
    requestHash: digest("command-request:1"),
    payload: { requestedState: "running", executionMode: "paper" },
    ...overrides
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expireLease(commandId: string): Promise<void> {
  await pool.query(
    `UPDATE executor_commands SET
       created_at = clock_timestamp() - interval '3 seconds',
       lease_acquired_at = clock_timestamp() - interval '2 seconds',
       lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE id = $1`,
    [commandId]
  );
}
