import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresExecutionStepLedgerRepository } from "../src/database/executionStepLedger.js";
import {
  ExecutionStepLedgerCapacityError,
  ExecutionStepLedgerDurableCapacityError,
  type ReserveExecutionStepInput
} from "../src/database/executionStepLedgerTypes.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString =
  process.env.EXECUTION_LEDGER_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000021";
const OWNER_B = "00000000-0000-4000-8000-000000000022";
let pool: Pool;
let repository: PostgresExecutionStepLedgerRepository;

describePostgres("execution step ledger against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 16 });
    await assertIsolatedTestDatabase(
      pool,
      process.env.EXECUTION_LEDGER_TEST_DATABASE_URL
        ? "EXECUTION_LEDGER_TEST_DATABASE_URL"
        : "JOBS_TEST_DATABASE_URL"
    );
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'ledger-owner-a', 'ledger-owner-a', $3, 'active'),
              ($2, 'ledger-owner-b', 'ledger-owner-b', $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, "test-password-hash-placeholder"]
    );
    repository = new PostgresExecutionStepLedgerRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE execution_step_reservations, execution_step_ledger, execution_step_ledger_owner_usage"
    );
    repository = new PostgresExecutionStepLedgerRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores only opaque identifiers, digests, revisions and reservation timestamps", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('execution_step_ledger', 'execution_step_reservations')
       ORDER BY table_name, ordinal_position`
    );

    expect(
      columns.rows
        .filter((row) => row.table_name === "execution_step_ledger")
        .map((row) => row.column_name)
    ).toEqual([
      "owner_user_id",
      "intent_id",
      "intent_digest",
      "signed_request_digest",
      "binding_digest",
      "created_at"
    ]);
    expect(
      columns.rows
        .filter((row) => row.table_name === "execution_step_reservations")
        .map((row) => row.column_name)
    ).toEqual([
      "owner_user_id",
      "intent_id",
      "account_id",
      "operation_kind",
      "operation_id",
      "account_revision",
      "credential_revision",
      "authorization_revision",
      "authorization_epoch",
      "live_arm_epoch",
      "status",
      "reservation_id",
      "reserved_at",
      "reservation_expires_at",
      "consumed_at",
      "terminal_at",
      "created_at",
      "updated_at"
    ]);
    for (const forbidden of ["json", "jsonb", "bytea"]) {
      expect(columns.rows.map((row) => row.data_type)).not.toContain(forbidden);
    }
    expect(columns.rows.map((row) => row.column_name).join(" ")).not.toMatch(
      /payload|secret|signature|api.?key|session|permit.?token/i
    );
  });

  it("atomically reserves one exact step and classifies concurrent retries as duplicates", async () => {
    const prepared = stepInput();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => repository.reserve(prepared))
    );

    expect(outcomes.filter((result) => result.outcome === "reserved")).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === "duplicate")).toHaveLength(11);
    const ids = outcomes.flatMap((result) =>
      result.outcome === "conflict"
        ? []
        : [result.outcome === "reserved" ? result.record.intentId : result.key.intentId]
    );
    expect(new Set(ids)).toHaveLength(1);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM execution_step_ledger"
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("rejects conflicting exact bindings, permits multi-step intents and isolates owners", async () => {
    await expect(repository.reserve(stepInput())).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      repository.reserve(stepInput({ signedRequestDigest: digest("request-conflict") }))
    ).resolves.toEqual({ outcome: "conflict", conflictOn: "intent-and-binding" });

    await expect(
      repository.reserve(
        stepInput({
          intentId: "intent-b",
          intentDigest: digest("intent-b"),
          bindingDigest: digest("binding-b"),
          signedRequestDigest: digest("request-b")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });

    const grouped = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_step_reservations
       WHERE owner_user_id = $1 AND operation_kind = 'bot' AND operation_id = 'run-a'`,
      [OWNER_A]
    );
    expect(grouped.rows[0]?.count).toBe("2");

    await expect(
      repository.reserve(stepInput({ ownerUserId: OWNER_B }))
    ).resolves.toMatchObject({ outcome: "reserved" });
  });

  it("treats a digest collision with mismatched revisions as a conflict, not a duplicate", async () => {
    await repository.reserve(stepInput());
    await expect(
      repository.reserve(stepInput({ credentialRevision: 3 }))
    ).resolves.toEqual({ outcome: "conflict", conflictOn: "intent-and-binding" });
  });

  it("lets only one matching reservation transition to consumed", async () => {
    const reserved = await repository.reserve(stepInput());
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") throw new Error("expected a reservation");
    const consumeInput = {
      ownerUserId: OWNER_A,
      intentId: reserved.record.intentId,
      reservationId: reserved.record.reservationId,
      bindingDigest: reserved.record.bindingDigest
    };

    const outcomes = await Promise.all([
      repository.consume(consumeInput),
      repository.consume(consumeInput)
    ]);
    expect(outcomes.filter((result) => result.outcome === "consumed")).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === "duplicate")).toHaveLength(1);
    await expect(
      repository.consume({ ...consumeInput, reservationId: randomUUID() })
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("expires stale reservations without making the same prepared step reusable", async () => {
    const reserved = await repository.reserve(stepInput());
    if (reserved.outcome !== "reserved") throw new Error("expected a reservation");
    await pool.query(
      `UPDATE execution_step_reservations SET
         reserved_at = clock_timestamp() - interval '2 seconds',
         reservation_expires_at = clock_timestamp() - interval '1 second'
       WHERE owner_user_id = $1 AND intent_id = $2`,
      [OWNER_A, reserved.record.intentId]
    );

    await expect(
      repository.consume({
        ownerUserId: OWNER_A,
        intentId: reserved.record.intentId,
        reservationId: reserved.record.reservationId,
        bindingDigest: reserved.record.bindingDigest
      })
    ).resolves.toEqual({ outcome: "expired" });
    await expect(repository.reserve(stepInput())).resolves.toMatchObject({
      outcome: "duplicate",
      record: { status: "expired" }
    });
  });

  it("enforces an owner-local active reservation bound", async () => {
    repository = new PostgresExecutionStepLedgerRepository(pool, {
      maxActivePerOwner: 2,
      reconciliationActiveHeadroom: 1,
      emergencyActiveHeadroom: 1
    });
    await repository.reserve(stepInput({ intentId: "intent-1", bindingDigest: digest("binding-1") }));
    await repository.reserve(stepInput({ intentId: "intent-2", bindingDigest: digest("binding-2") }));

    await expect(
      repository.reserve(stepInput({ intentId: "intent-3", bindingDigest: digest("binding-3") }))
    ).rejects.toBeInstanceOf(ExecutionStepLedgerCapacityError);
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "reconciliation",
          operationId: "reconciliation-1",
          intentId: "reconciliation-intent-1",
          bindingDigest: digest("reconciliation-binding-1")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "reconciliation",
          operationId: "reconciliation-2",
          intentId: "reconciliation-intent-2",
          bindingDigest: digest("reconciliation-binding-2")
        })
      )
    ).rejects.toBeInstanceOf(ExecutionStepLedgerCapacityError);
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "emergency",
          operationId: "emergency-1",
          intentId: "emergency-intent-1",
          bindingDigest: digest("emergency-binding-1")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "emergency",
          operationId: "emergency-2",
          intentId: "emergency-intent-2",
          bindingDigest: digest("emergency-binding-2")
        })
      )
    ).rejects.toBeInstanceOf(ExecutionStepLedgerCapacityError);
    await expect(
      repository.reserve(
        stepInput({
          ownerUserId: OWNER_B,
          intentId: "intent-3",
          bindingDigest: digest("binding-3")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });
  });

  it("fails closed at the owner durable-key cap while preserving duplicate lookup", async () => {
    repository = new PostgresExecutionStepLedgerRepository(pool, {
      maxDurableKeysPerOwner: 2,
      reconciliationDurableHeadroom: 1,
      emergencyDurableHeadroom: 1
    });
    await repository.reserve(stepInput({ intentId: "intent-1", bindingDigest: digest("binding-1") }));
    await repository.reserve(stepInput({ intentId: "intent-2", bindingDigest: digest("binding-2") }));

    await expect(
      repository.reserve(stepInput({ intentId: "intent-3", bindingDigest: digest("binding-3") }))
    ).rejects.toBeInstanceOf(ExecutionStepLedgerDurableCapacityError);
    await expect(
      repository.reserve(stepInput({ intentId: "intent-1", bindingDigest: digest("binding-1") }))
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "reconciliation",
          operationId: "reconciliation-1",
          intentId: "reconciliation-intent-1",
          bindingDigest: digest("reconciliation-binding-1")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "reconciliation",
          operationId: "reconciliation-2",
          intentId: "reconciliation-intent-2",
          bindingDigest: digest("reconciliation-binding-2")
        })
      )
    ).rejects.toBeInstanceOf(ExecutionStepLedgerDurableCapacityError);
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "emergency",
          operationId: "emergency-1",
          intentId: "emergency-intent-1",
          bindingDigest: digest("emergency-binding-1")
        })
      )
    ).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      repository.reserve(
        stepInput({
          operationKind: "emergency",
          operationId: "emergency-2",
          intentId: "emergency-intent-2",
          bindingDigest: digest("emergency-binding-2")
        })
      )
    ).rejects.toBeInstanceOf(ExecutionStepLedgerDurableCapacityError);
  });

  it("prunes terminal rows by age and per-owner count in bounded batches", async () => {
    repository = new PostgresExecutionStepLedgerRepository(pool, {
      terminalRetentionMs: 1_000,
      maxTerminalRowsPerOwner: 2,
      batchSize: 10
    });
    let firstReservation:
      | { intentId: string; reservationId: string; bindingDigest: string }
      | undefined;
    for (let index = 1; index <= 4; index += 1) {
      const reserved = await repository.reserve(
        stepInput({
          intentId: `intent-${index}`,
          intentDigest: digest(`intent-${index}`),
          signedRequestDigest: digest(`request-${index}`),
          bindingDigest: digest(`binding-${index}`)
        })
      );
      if (reserved.outcome !== "reserved") throw new Error("expected a reservation");
      if (index === 1) {
        firstReservation = {
          intentId: reserved.record.intentId,
          reservationId: reserved.record.reservationId,
          bindingDigest: reserved.record.bindingDigest
        };
      }
      await repository.consume({
        ownerUserId: OWNER_A,
        intentId: reserved.record.intentId,
        reservationId: reserved.record.reservationId,
        bindingDigest: reserved.record.bindingDigest
      });
    }

    const bounded = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_step_ledger
      ledger JOIN execution_step_reservations reservation
         ON reservation.owner_user_id = ledger.owner_user_id
         AND reservation.intent_id = ledger.intent_id
       WHERE ledger.owner_user_id = $1 AND reservation.status = 'consumed'`,
      [OWNER_A]
    );
    expect(bounded.rows[0]?.count).toBe("2");

    await pool.query(
      `UPDATE execution_step_reservations SET
         reserved_at = clock_timestamp() - interval '4 seconds',
         reservation_expires_at = clock_timestamp() - interval '3 seconds',
         consumed_at = clock_timestamp() - interval '2 seconds',
         terminal_at = clock_timestamp() - interval '2 seconds',
         updated_at = clock_timestamp() - interval '2 seconds'
       WHERE owner_user_id = $1`,
      [OWNER_A]
    );
    await expect(repository.pruneOwner(OWNER_A)).resolves.toMatchObject({ deletedByAge: 2 });
    const empty = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM execution_step_reservations WHERE owner_user_id = $1",
      [OWNER_A]
    );
    expect(empty.rows[0]?.count).toBe("0");

    const compactKeys = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM execution_step_ledger WHERE owner_user_id = $1",
      [OWNER_A]
    );
    expect(compactKeys.rows[0]?.count).toBe("4");
    await expect(
      repository.reserve(
        stepInput({
          intentId: "intent-1",
          intentDigest: digest("intent-1"),
          signedRequestDigest: digest("request-1"),
          bindingDigest: digest("binding-1")
        })
      )
    ).resolves.toMatchObject({
      outcome: "duplicate",
      key: { intentId: "intent-1" }
    });
    if (!firstReservation) throw new Error("first reservation was not captured");
    await expect(
      repository.consume({ ownerUserId: OWNER_A, ...firstReservation })
    ).resolves.toEqual({ outcome: "tombstone" });
    await expect(
      repository.consume({
        ownerUserId: OWNER_A,
        ...firstReservation,
        bindingDigest: digest("wrong-binding")
      })
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("round-trips the durable revision fence without coercion", async () => {
    const reserved = await repository.reserve(
      stepInput({
        accountId: "managed desk / A",
        operationId: "run group:14",
        intentId: "entry leg / 14",
        accountRevision: 11,
        credentialRevision: 12,
        authorizationRevision: 13,
        authorizationEpoch: 0,
        liveArmEpoch: 15
      })
    );

    expect(reserved).toMatchObject({
      outcome: "reserved",
      record: {
        accountId: "managed desk / A",
        operationId: "run group:14",
        intentId: "entry leg / 14",
        accountRevision: 11,
        credentialRevision: 12,
        authorizationRevision: 13,
        authorizationEpoch: 0,
        liveArmEpoch: 15
      }
    });
  });
});

function stepInput(overrides: Partial<ReserveExecutionStepInput> = {}): ReserveExecutionStepInput {
  return {
    ownerUserId: OWNER_A,
    accountId: "account-a",
    operationKind: "bot",
    operationId: "run-a",
    intentId: "intent-a",
    intentDigest: digest("intent-a"),
    signedRequestDigest: digest("request-a"),
    bindingDigest: digest("binding-a"),
    accountRevision: 1,
    credentialRevision: 2,
    authorizationRevision: 3,
    authorizationEpoch: 4,
    liveArmEpoch: 5,
    ...overrides
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
