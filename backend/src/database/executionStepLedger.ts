import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  boundedInteger,
  requireBoundedId,
  requireDigest,
  requireUuid,
  retentionOptions,
  safeInteger,
  validateReserveInput
} from "./executionStepLedgerValidation.js";
import {
  DEFAULT_EXECUTION_STEP_MAX_ACTIVE_PER_OWNER,
  DEFAULT_EXECUTION_STEP_MAX_DURABLE_KEYS_PER_OWNER,
  DEFAULT_EXECUTION_STEP_MAX_TERMINAL_ROWS_PER_OWNER,
  DEFAULT_EXECUTION_STEP_PRUNE_BATCH_SIZE,
  DEFAULT_EXECUTION_STEP_RESERVATION_TTL_MS,
  DEFAULT_EXECUTION_STEP_RECONCILIATION_ACTIVE_HEADROOM,
  DEFAULT_EXECUTION_STEP_RECONCILIATION_DURABLE_HEADROOM,
  DEFAULT_EXECUTION_STEP_EMERGENCY_ACTIVE_HEADROOM,
  DEFAULT_EXECUTION_STEP_EMERGENCY_DURABLE_HEADROOM,
  DEFAULT_EXECUTION_STEP_TERMINAL_RETENTION_MS,
  EXECUTION_STEP_OPERATION_KINDS,
  ExecutionStepLedgerCapacityError,
  ExecutionStepLedgerDurableCapacityError,
  MAX_EXECUTION_STEP_DURABLE_KEYS_PER_OWNER,
  type ConsumeExecutionStepInput,
  type ConsumeExecutionStepResult,
  type ExecutionStepLedgerKey,
  type ExecutionStepLedgerPruneResult,
  type ExecutionStepLedgerRecord,
  type ExecutionStepLedgerRepository,
  type ExecutionStepLedgerRepositoryOptions,
  type ExecutionStepLedgerRetentionOptions,
  type ExecutionStepLedgerStatus,
  type ExecutionStepOperationKind,
  type ReserveExecutionStepInput,
  type ReserveExecutionStepResult
} from "./executionStepLedgerTypes.js";

const TERMINAL_STATUSES = ["consumed", "expired"] as const;

interface ExecutionStepLedgerRow {
  owner_user_id: string;
  intent_id: string;
  intent_digest: string;
  signed_request_digest: string;
  binding_digest: string;
  ledger_created_at: Date;
  account_id: string | null;
  operation_kind: ExecutionStepOperationKind | null;
  operation_id: string | null;
  account_revision: string | null;
  credential_revision: string | null;
  authorization_revision: string | null;
  authorization_epoch: string | null;
  live_arm_epoch: string | null;
  status: ExecutionStepLedgerStatus | null;
  reservation_id: string | null;
  reserved_at: Date | null;
  reservation_expires_at: Date | null;
  consumed_at: Date | null;
  terminal_at: Date | null;
  reservation_created_at: Date | null;
  updated_at: Date | null;
}

const JOINED_COLUMNS = `
  ledger.owner_user_id, ledger.intent_id, ledger.intent_digest,
  ledger.signed_request_digest, ledger.binding_digest,
  ledger.created_at AS ledger_created_at,
  reservation.account_id, reservation.operation_kind, reservation.operation_id,
  reservation.account_revision, reservation.credential_revision,
  reservation.authorization_revision, reservation.authorization_epoch,
  reservation.live_arm_epoch, reservation.status, reservation.reservation_id,
  reservation.reserved_at, reservation.reservation_expires_at,
  reservation.consumed_at, reservation.terminal_at,
  reservation.created_at AS reservation_created_at, reservation.updated_at
`;

/** Durable replay keys are never pruned; bounded reservation details contain no secrets or payloads. */
export class PostgresExecutionStepLedgerRepository implements ExecutionStepLedgerRepository {
  private readonly defaultReservationTtlMs: number;
  private readonly maxReservationTtlMs: number;
  private readonly maxActivePerOwner: number;
  private readonly reconciliationActiveHeadroom: number;
  private readonly emergencyActiveHeadroom: number;
  private readonly maxDurableKeysPerOwner: number;
  private readonly reconciliationDurableHeadroom: number;
  private readonly emergencyDurableHeadroom: number;
  private readonly retention: Required<ExecutionStepLedgerRetentionOptions>;

  constructor(
    private readonly pool: Pool,
    options: ExecutionStepLedgerRepositoryOptions = {}
  ) {
    this.maxReservationTtlMs = boundedInteger(
      options.maxReservationTtlMs ?? 300_000,
      "maxReservationTtlMs",
      1_000,
      3_600_000
    );
    this.defaultReservationTtlMs = boundedInteger(
      options.defaultReservationTtlMs ?? DEFAULT_EXECUTION_STEP_RESERVATION_TTL_MS,
      "defaultReservationTtlMs",
      1_000,
      this.maxReservationTtlMs
    );
    this.maxActivePerOwner = boundedInteger(
      options.maxActivePerOwner ?? DEFAULT_EXECUTION_STEP_MAX_ACTIVE_PER_OWNER,
      "maxActivePerOwner",
      1,
      10_000
    );
    this.reconciliationActiveHeadroom = boundedInteger(
      options.reconciliationActiveHeadroom ?? DEFAULT_EXECUTION_STEP_RECONCILIATION_ACTIVE_HEADROOM,
      "reconciliationActiveHeadroom",
      1,
      10_000
    );
    this.emergencyActiveHeadroom = boundedInteger(
      options.emergencyActiveHeadroom ?? DEFAULT_EXECUTION_STEP_EMERGENCY_ACTIVE_HEADROOM,
      "emergencyActiveHeadroom",
      1,
      10_000
    );
    this.reconciliationDurableHeadroom = boundedInteger(
      options.reconciliationDurableHeadroom ?? DEFAULT_EXECUTION_STEP_RECONCILIATION_DURABLE_HEADROOM,
      "reconciliationDurableHeadroom",
      1,
      MAX_EXECUTION_STEP_DURABLE_KEYS_PER_OWNER - 1
    );
    this.emergencyDurableHeadroom = boundedInteger(
      options.emergencyDurableHeadroom ?? DEFAULT_EXECUTION_STEP_EMERGENCY_DURABLE_HEADROOM,
      "emergencyDurableHeadroom",
      1,
      MAX_EXECUTION_STEP_DURABLE_KEYS_PER_OWNER - this.reconciliationDurableHeadroom - 1
    );
    this.maxDurableKeysPerOwner = boundedInteger(
      options.maxDurableKeysPerOwner ?? DEFAULT_EXECUTION_STEP_MAX_DURABLE_KEYS_PER_OWNER,
      "maxDurableKeysPerOwner",
      1,
      MAX_EXECUTION_STEP_DURABLE_KEYS_PER_OWNER
        - this.reconciliationDurableHeadroom
        - this.emergencyDurableHeadroom
    );
    this.retention = retentionOptions(options);
  }

  async reserve(input: ReserveExecutionStepInput): Promise<ReserveExecutionStepResult> {
    const prepared = validateReserveInput(input, this.defaultReservationTtlMs, this.maxReservationTtlMs);
    return this.withOwnerTransaction(prepared.ownerUserId, async (client) => {
      await this.pruneOwnerInTransaction(client, prepared.ownerUserId, this.retention);
      const existing = await findConflictingRows(
        client,
        prepared.ownerUserId,
        prepared.intentId,
        prepared.bindingDigest
      );
      if (existing.length > 0) return classifyExisting(prepared, existing);

      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM execution_step_reservations
         WHERE owner_user_id = $1 AND status = 'reserved'
           AND reservation_expires_at > clock_timestamp()`,
        [prepared.ownerUserId]
      );
      const activeLimit = this.activeLimit(prepared.operationKind);
      if (safeInteger(active.rows[0]?.count ?? "0", "active reservation count") >= activeLimit) {
        throw new ExecutionStepLedgerCapacityError(activeLimit);
      }

      const durableLimit = this.durableLimit(prepared.operationKind);
      const durableCapacity = await client.query<{ durable_key_count: string }>(
        `INSERT INTO execution_step_ledger_owner_usage (owner_user_id, durable_key_count)
         VALUES ($1, 1)
         ON CONFLICT (owner_user_id) DO UPDATE SET
           durable_key_count = execution_step_ledger_owner_usage.durable_key_count + 1
         WHERE execution_step_ledger_owner_usage.durable_key_count < $2
         RETURNING durable_key_count::text`,
        [prepared.ownerUserId, durableLimit]
      );
      if (!durableCapacity.rows[0]) {
        throw new ExecutionStepLedgerDurableCapacityError(durableLimit);
      }

      await client.query(
        `INSERT INTO execution_step_ledger (
           owner_user_id, intent_id, intent_digest,
           signed_request_digest, binding_digest
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          prepared.ownerUserId,
          prepared.intentId,
          prepared.intentDigest,
          prepared.signedRequestDigest,
          prepared.bindingDigest
        ]
      );
      await client.query(
        `INSERT INTO execution_step_reservations (
           owner_user_id, intent_id, account_id, operation_kind, operation_id,
           account_revision, credential_revision, authorization_revision,
           authorization_epoch, live_arm_epoch, reservation_id,
           reservation_expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           clock_timestamp() + ($12::bigint * interval '1 millisecond')
         )`,
        [
          prepared.ownerUserId,
          prepared.intentId,
          prepared.accountId,
          prepared.operationKind,
          prepared.operationId,
          prepared.accountRevision,
          prepared.credentialRevision,
          prepared.authorizationRevision,
          prepared.authorizationEpoch,
          prepared.liveArmEpoch,
          randomUUID(),
          prepared.reservationTtlMs
        ]
      );
      const inserted = await findExactRow(client, prepared.ownerUserId, prepared.intentId);
      if (!inserted || !hasReservation(inserted)) {
        throw new Error("PostgreSQL did not return the reserved execution step");
      }
      return { outcome: "reserved", record: mapRecord(inserted) };
    });
  }

  async consume(input: ConsumeExecutionStepInput): Promise<ConsumeExecutionStepResult> {
    const ownerUserId = requireUuid(input.ownerUserId, "ownerUserId");
    const intentId = requireBoundedId(input.intentId, "intentId");
    const reservationId = requireUuid(input.reservationId, "reservationId");
    const bindingDigest = requireDigest(input.bindingDigest, "bindingDigest");
    return this.withOwnerTransaction(ownerUserId, async (client) => {
      const transition = await client.query<{ status: ExecutionStepLedgerStatus }>(
        `WITH execution_decision AS MATERIALIZED (
           SELECT clock_timestamp() AS decided_at
         )
         UPDATE execution_step_reservations reservation SET
           status = CASE
             WHEN reservation.reservation_expires_at <= execution_decision.decided_at
               THEN 'expired'
             ELSE 'consumed'
           END,
           consumed_at = CASE
             WHEN reservation.reservation_expires_at <= execution_decision.decided_at
               THEN NULL
             ELSE execution_decision.decided_at
           END,
           terminal_at = execution_decision.decided_at,
           updated_at = execution_decision.decided_at
         FROM execution_step_ledger ledger, execution_decision
         WHERE reservation.owner_user_id = $1 AND reservation.intent_id = $2
           AND reservation.reservation_id = $3
           AND ledger.owner_user_id = reservation.owner_user_id
           AND ledger.intent_id = reservation.intent_id
           AND ledger.binding_digest = $4
           AND reservation.status = 'reserved'
         RETURNING reservation.status`,
        [ownerUserId, intentId, reservationId, bindingDigest]
      );
      if (transition.rows[0]?.status === "consumed") {
        const current = await findExactRow(client, ownerUserId, intentId);
        if (!current || !hasReservation(current)) throw new Error("Consumed execution step disappeared");
        await this.pruneOwnerInTransaction(client, ownerUserId, this.retention);
        return { outcome: "consumed", record: mapRecord(current) };
      }
      if (transition.rows[0]?.status === "expired") return { outcome: "expired" };
      const current = await findExactRow(client, ownerUserId, intentId);
      if (!current) return { outcome: "missing" };
      if (current.binding_digest !== bindingDigest) return { outcome: "conflict" };
      if (!hasReservation(current)) return { outcome: "tombstone" };
      if (current.reservation_id !== reservationId) {
        return { outcome: "conflict" };
      }
      if (current.status === "consumed") return { outcome: "duplicate", status: "consumed" };
      return { outcome: "expired" };
    });
  }

  async pruneOwner(
    ownerUserId: string,
    options: ExecutionStepLedgerRetentionOptions = {}
  ): Promise<ExecutionStepLedgerPruneResult> {
    const owner = requireUuid(ownerUserId, "ownerUserId");
    const retention = retentionOptions({ ...this.retention, ...options });
    return this.withOwnerTransaction(owner, (client) =>
      this.pruneOwnerInTransaction(client, owner, retention)
    );
  }

  private async pruneOwnerInTransaction(
    client: PoolClient,
    ownerUserId: string,
    options: Required<ExecutionStepLedgerRetentionOptions>
  ): Promise<ExecutionStepLedgerPruneResult> {
    const expired = await client.query(
      `WITH candidates AS (
         SELECT intent_id FROM execution_step_reservations
         WHERE owner_user_id = $1 AND status = 'reserved'
           AND reservation_expires_at <= clock_timestamp()
         ORDER BY reservation_expires_at ASC
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE execution_step_reservations reservation SET
         status = 'expired',
         terminal_at = GREATEST(clock_timestamp(), reservation.reservation_expires_at),
         updated_at = clock_timestamp()
       FROM candidates
       WHERE reservation.owner_user_id = $1
         AND reservation.intent_id = candidates.intent_id`,
      [ownerUserId, options.batchSize]
    );
    const deletedByAge = await client.query(
      `WITH candidates AS (
         SELECT intent_id FROM execution_step_reservations
         WHERE owner_user_id = $1 AND status = ANY($2::varchar[])
           AND terminal_at < clock_timestamp() - ($3::bigint * interval '1 millisecond')
         ORDER BY terminal_at ASC, intent_id ASC
         LIMIT $4 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM execution_step_reservations reservation USING candidates
       WHERE reservation.owner_user_id = $1
         AND reservation.intent_id = candidates.intent_id`,
      [ownerUserId, TERMINAL_STATUSES, options.terminalRetentionMs, options.batchSize]
    );
    const deletedByCount = await client.query(
      `WITH candidates AS (
         SELECT intent_id FROM execution_step_reservations
         WHERE owner_user_id = $1 AND status = ANY($2::varchar[])
         ORDER BY terminal_at DESC, intent_id DESC
         OFFSET $3 LIMIT $4 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM execution_step_reservations reservation USING candidates
       WHERE reservation.owner_user_id = $1
         AND reservation.intent_id = candidates.intent_id`,
      [ownerUserId, TERMINAL_STATUSES, options.maxTerminalRowsPerOwner, options.batchSize]
    );
    return {
      expired: expired.rowCount ?? 0,
      deletedByAge: deletedByAge.rowCount ?? 0,
      deletedByCount: deletedByCount.rowCount ?? 0
    };
  }

  private async withOwnerTransaction<T>(
    ownerUserId: string,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1397314374))",
        [ownerUserId]
      );
      const result = await operation(client);
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private activeLimit(operationKind: ExecutionStepOperationKind): number {
    if (operationKind === "emergency") {
      return this.maxActivePerOwner
        + this.reconciliationActiveHeadroom
        + this.emergencyActiveHeadroom;
    }
    if (operationKind === "reconciliation") {
      return this.maxActivePerOwner + this.reconciliationActiveHeadroom;
    }
    return this.maxActivePerOwner;
  }

  private durableLimit(operationKind: ExecutionStepOperationKind): number {
    if (operationKind === "emergency") {
      return this.maxDurableKeysPerOwner
        + this.reconciliationDurableHeadroom
        + this.emergencyDurableHeadroom;
    }
    if (operationKind === "reconciliation") {
      return this.maxDurableKeysPerOwner + this.reconciliationDurableHeadroom;
    }
    return this.maxDurableKeysPerOwner;
  }
}

async function findConflictingRows(
  client: PoolClient,
  ownerUserId: string,
  intentId: string,
  bindingDigest: string
): Promise<ExecutionStepLedgerRow[]> {
  const found = await client.query<ExecutionStepLedgerRow>(
    `SELECT ${JOINED_COLUMNS}
     FROM execution_step_ledger ledger
     LEFT JOIN execution_step_reservations reservation
       ON reservation.owner_user_id = ledger.owner_user_id
       AND reservation.intent_id = ledger.intent_id
     WHERE ledger.owner_user_id = $1
       AND (ledger.intent_id = $2 OR ledger.binding_digest = $3)
     ORDER BY ledger.created_at ASC, ledger.intent_id ASC
     FOR UPDATE OF ledger`,
    [ownerUserId, intentId, bindingDigest]
  );
  return found.rows;
}

async function findExactRow(
  client: PoolClient,
  ownerUserId: string,
  intentId: string
): Promise<ExecutionStepLedgerRow | undefined> {
  const found = await client.query<ExecutionStepLedgerRow>(
    `SELECT ${JOINED_COLUMNS}
     FROM execution_step_ledger ledger
     LEFT JOIN execution_step_reservations reservation
       ON reservation.owner_user_id = ledger.owner_user_id
       AND reservation.intent_id = ledger.intent_id
     WHERE ledger.owner_user_id = $1 AND ledger.intent_id = $2
     FOR UPDATE OF ledger`,
    [ownerUserId, intentId]
  );
  return found.rows[0];
}

function classifyExisting(
  input: Required<ReserveExecutionStepInput>,
  rows: readonly ExecutionStepLedgerRow[]
): ReserveExecutionStepResult {
  if (rows.length === 1 && exactPreparedStep(input, rows[0]!)) {
    const row = rows[0]!;
    return {
      outcome: "duplicate",
      key: mapKey(row),
      ...(hasReservation(row) ? { record: mapRecord(row) } : {})
    };
  }
  const intent = rows.some((row) => row.intent_id === input.intentId);
  const binding = rows.some((row) => row.binding_digest === input.bindingDigest);
  return {
    outcome: "conflict",
    conflictOn: intent && binding ? "intent-and-binding" : intent ? "intent" : "binding"
  };
}

function exactPreparedStep(input: Required<ReserveExecutionStepInput>, row: ExecutionStepLedgerRow): boolean {
  if (
    row.owner_user_id !== input.ownerUserId
    || row.intent_id !== input.intentId
    || row.intent_digest !== input.intentDigest
    || row.signed_request_digest !== input.signedRequestDigest
    || row.binding_digest !== input.bindingDigest
  ) {
    return false;
  }
  if (!hasReservation(row)) return true;
  return (
    row.account_id === input.accountId
    && row.operation_kind === input.operationKind
    && row.operation_id === input.operationId
    && safeInteger(row.account_revision, "account revision") === input.accountRevision
    && safeInteger(row.credential_revision, "credential revision") === input.credentialRevision
    && safeInteger(row.authorization_revision, "authorization revision") === input.authorizationRevision
    && safeInteger(row.authorization_epoch, "authorization epoch") === input.authorizationEpoch
    && safeInteger(row.live_arm_epoch, "live arm epoch") === input.liveArmEpoch
  );
}

function hasReservation(
  row: ExecutionStepLedgerRow
): row is ExecutionStepLedgerRow & {
  account_id: string;
  operation_kind: ExecutionStepOperationKind;
  operation_id: string;
  account_revision: string;
  credential_revision: string;
  authorization_revision: string;
  authorization_epoch: string;
  live_arm_epoch: string;
  status: ExecutionStepLedgerStatus;
  reservation_id: string;
  reserved_at: Date;
  reservation_expires_at: Date;
  reservation_created_at: Date;
  updated_at: Date;
} {
  return row.reservation_id !== null;
}

function mapKey(row: ExecutionStepLedgerRow): ExecutionStepLedgerKey {
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    intentId: row.intent_id,
    intentDigest: row.intent_digest,
    signedRequestDigest: row.signed_request_digest,
    bindingDigest: row.binding_digest,
    createdAt: row.ledger_created_at
  });
}

function mapRecord(row: ExecutionStepLedgerRow & { reservation_id: string }): ExecutionStepLedgerRecord {
  if (!hasReservation(row)) throw new Error("Execution step reservation detail is unavailable");
  return Object.freeze({
    ...mapKey(row),
    accountId: row.account_id,
    operationKind: row.operation_kind,
    operationId: row.operation_id,
    accountRevision: safeInteger(row.account_revision, "account revision"),
    credentialRevision: safeInteger(row.credential_revision, "credential revision"),
    authorizationRevision: safeInteger(row.authorization_revision, "authorization revision"),
    authorizationEpoch: safeInteger(row.authorization_epoch, "authorization epoch"),
    liveArmEpoch: safeInteger(row.live_arm_epoch, "live arm epoch"),
    status: row.status,
    reservationId: row.reservation_id,
    reservedAt: row.reserved_at,
    reservationExpiresAt: row.reservation_expires_at,
    consumedAt: row.consumed_at,
    terminalAt: row.terminal_at,
    reservationCreatedAt: row.reservation_created_at,
    updatedAt: row.updated_at
  });
}
