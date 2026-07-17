import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  mapExecutorCommand,
  selectExecutorCommandSql,
  type ExecutorCommandRow
} from "./executorCommandRows.js";
import { pruneExecutorCommandsForOwner } from "./executorCommandRetention.js";
import {
  DEFAULT_EXECUTOR_COMMAND_LEASE_MS,
  ExecutorCommandCapacityError,
  ExecutorCommandIdempotencyConflictError,
  type AcknowledgeAppliedExecutorCommandInput,
  type AcknowledgeRejectedExecutorCommandInput,
  type ClaimedExecutorCommand,
  type EnqueueExecutorCommandInput,
  type EnqueueExecutorCommandResult,
  type ExecutorCommand,
  type ExecutorCommandAcknowledgementResult,
  type ExecutorCommandLeaseFence,
  type ExecutorCommandPruneResult,
  type ExecutorCommandRepository,
  type ExecutorCommandRepositoryOptions,
  type ExecutorCommandRetentionOptions
} from "./executorCommandTypes.js";
import {
  executorCommandSafeInteger,
  requireExecutorCommandUuid,
  validateAppliedExecutorCommandAcknowledgement,
  validateEnqueueExecutorCommandInput,
  validateExecutorCommandLease,
  validateExecutorCommandLeaseFence,
  validateExecutorCommandListLimit,
  validateExecutorCommandRepositoryOptions,
  validateRejectedExecutorCommandAcknowledgement,
  type ValidatedExecutorCommandOptions
} from "./executorCommandValidation.js";

const EXECUTOR_COMMAND_ADVISORY_LOCK_NAMESPACE = 1_614_704_467;
const EXHAUSTED_RECOVERY_BATCH_SIZE = 1_000;

/** PostgreSQL system of record for fenced, idempotent commands sent to the singleton executor. */
export class PostgresExecutorCommandRepository implements ExecutorCommandRepository {
  private readonly options: ValidatedExecutorCommandOptions;

  constructor(
    private readonly pool: Pool,
    options: ExecutorCommandRepositoryOptions = {}
  ) {
    this.options = validateExecutorCommandRepositoryOptions(options);
  }

  async enqueue(input: EnqueueExecutorCommandInput): Promise<EnqueueExecutorCommandResult> {
    const command = validateEnqueueExecutorCommandInput(input);
    return this.transaction(async (client) => {
      await this.lockOwner(client, command.ownerUserId);
      await pruneExecutorCommandsForOwner(client, command.ownerUserId, this.options);

      const existing = await client.query<ExecutorCommandRow>(
        `${selectExecutorCommandSql()}
         WHERE owner_user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [command.ownerUserId, command.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== command.requestHash) {
          throw new ExecutorCommandIdempotencyConflictError();
        }
        return { outcome: "replayed", command: mapExecutorCommand(existing.rows[0]) };
      }

      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM executor_commands
         WHERE owner_user_id = $1 AND status IN ('queued', 'applying')`,
        [command.ownerUserId]
      );
      if (
        executorCommandSafeInteger(active.rows[0]?.count ?? "0", "active command count")
        >= this.options.maxActivePerOwner
      ) {
        throw new ExecutorCommandCapacityError(this.options.maxActivePerOwner);
      }

      const inserted = await client.query<ExecutorCommandRow>(
        `INSERT INTO executor_commands (
           id, owner_user_id, actor_user_id, session_id_hash,
           authorization_revision, authorization_epoch,
           command_type, target_type, target_id,
           idempotency_key, request_hash, payload, max_attempts
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
         )
         RETURNING *`,
        [
          randomUUID(),
          command.ownerUserId,
          command.actorUserId,
          command.sessionIdHash,
          command.authorizationRevision,
          command.authorizationEpoch,
          command.commandType,
          command.targetType,
          command.targetId,
          command.idempotencyKey,
          command.requestHash,
          command.payloadJson,
          this.options.maxAttempts
        ]
      );
      return { outcome: "enqueued", command: mapExecutorCommand(inserted.rows[0]!) };
    });
  }

  /** Tenant-facing reads always require the authenticated owner identifier. */
  async get(ownerUserId: string, commandId: string): Promise<ExecutorCommand | undefined> {
    const owner = requireExecutorCommandUuid(ownerUserId, "ownerUserId");
    const id = requireExecutorCommandUuid(commandId, "commandId");
    const result = await this.pool.query<ExecutorCommandRow>(
      `${selectExecutorCommandSql()} WHERE owner_user_id = $1 AND id = $2`,
      [owner, id]
    );
    return result.rows[0] && mapExecutorCommand(result.rows[0]);
  }

  /** Tenant-facing reads always require the authenticated owner identifier. */
  async list(ownerUserId: string, limit = 50): Promise<ExecutorCommand[]> {
    const owner = requireExecutorCommandUuid(ownerUserId, "ownerUserId");
    const boundedLimit = validateExecutorCommandListLimit(limit);
    const result = await this.pool.query<ExecutorCommandRow>(
      `${selectExecutorCommandSql()}
       WHERE owner_user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [owner, boundedLimit]
    );
    return result.rows.map(mapExecutorCommand);
  }

  /**
   * Claims either a new command or an expired application lease. Every claim
   * advances both the opaque token and the monotonic generation fence.
   */
  async claim(
    workerId: string,
    leaseMs = DEFAULT_EXECUTOR_COMMAND_LEASE_MS
  ): Promise<ClaimedExecutorCommand | undefined> {
    const lease = validateExecutorCommandLease(workerId, leaseMs);
    await this.recoverExpiredLeases();
    const leaseToken = randomUUID();
    let rows: ExecutorCommandRow[];
    try {
      const result = await this.pool.query<ExecutorCommandRow>(
        `WITH candidate AS MATERIALIZED (
         SELECT command.id, command.owner_user_id
         FROM executor_commands command
         WHERE command.attempt < command.max_attempts
           AND (
             (
               command.status = 'applying'
               AND command.lease_expires_at <= clock_timestamp()
             )
             OR (
               command.status = 'queued'
               AND NOT EXISTS (
                 SELECT 1 FROM executor_commands active
                 WHERE active.owner_user_id = command.owner_user_id
                   AND active.status = 'applying'
               )
             )
           )
         ORDER BY
           CASE WHEN command.status = 'applying' THEN 0 ELSE 1 END,
           command.created_at ASC,
           command.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ), owner_locked AS MATERIALIZED (
         SELECT id, owner_user_id
         FROM candidate
         WHERE pg_try_advisory_xact_lock(
           $4::integer,
           hashtext(owner_user_id::text)
         )
       ), eligible AS (
         SELECT locked.id
         FROM owner_locked locked
         INNER JOIN executor_commands command ON command.id = locked.id
         WHERE (
           command.status = 'applying'
           AND command.lease_expires_at <= clock_timestamp()
         ) OR (
           command.status = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM executor_commands active
             WHERE active.owner_user_id = command.owner_user_id
               AND active.status = 'applying'
           )
         )
       ), lease_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS acquired_at
       )
       UPDATE executor_commands command SET
         status = 'applying',
         attempt = command.attempt + 1,
         lease_generation = command.lease_generation + 1,
         lease_owner = $1,
         lease_token = $2,
         lease_acquired_at = lease_clock.acquired_at,
         lease_expires_at = lease_clock.acquired_at
           + ($3::bigint * interval '1 millisecond'),
         updated_at = lease_clock.acquired_at
       FROM eligible, lease_clock
       WHERE command.id = eligible.id
         RETURNING command.*`,
        [
          lease.workerId,
          leaseToken,
          lease.leaseMs,
          EXECUTOR_COMMAND_ADVISORY_LOCK_NAMESPACE
        ]
      );
      rows = result.rows;
    } catch (error) {
      if (isApplyingOwnerConflict(error)) return undefined;
      throw error;
    }
    const row = rows[0];
    if (!row) return undefined;
    const command = mapExecutorCommand(row);
    if (
      command.status !== "applying"
      || !command.leaseOwner
      || !command.leaseToken
      || !command.leaseAcquiredAt
      || !command.leaseExpiresAt
    ) {
      throw new Error("PostgreSQL returned an invalid claimed executor command");
    }
    return {
      ...command,
      status: "applying",
      leaseOwner: command.leaseOwner,
      leaseToken: command.leaseToken,
      leaseAcquiredAt: command.leaseAcquiredAt,
      leaseExpiresAt: command.leaseExpiresAt
    };
  }

  async renewLease(
    fence: ExecutorCommandLeaseFence,
    leaseMs = DEFAULT_EXECUTOR_COMMAND_LEASE_MS
  ): Promise<boolean> {
    const validatedFence = validateExecutorCommandLeaseFence(fence);
    const lease = validateExecutorCommandLease("lease-renewal", leaseMs);
    const result = await this.pool.query(
      `WITH lease_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS renewed_at
       )
       UPDATE executor_commands SET
         lease_expires_at = lease_clock.renewed_at
           + ($4::bigint * interval '1 millisecond'),
         updated_at = lease_clock.renewed_at
       FROM lease_clock
       WHERE id = $1
         AND lease_token = $2
         AND lease_generation = $3
         AND status = 'applying'
         AND lease_expires_at > lease_clock.renewed_at`,
      [
        validatedFence.commandId,
        validatedFence.leaseToken,
        validatedFence.leaseGeneration,
        lease.leaseMs
      ]
    );
    return result.rowCount === 1;
  }

  async acknowledgeApplied(
    input: AcknowledgeAppliedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult> {
    const acknowledgement = validateAppliedExecutorCommandAcknowledgement(input);
    const result = await this.pool.query<ExecutorCommandRow>(
      `WITH decision AS MATERIALIZED (
         SELECT clock_timestamp() AS decided_at
       )
       UPDATE executor_commands SET
         status = 'applied',
         sqlite_receipt_hash = $4,
         result = $5::jsonb,
         error_code = NULL,
         error_message = NULL,
         lease_owner = NULL,
         lease_token = NULL,
         lease_acquired_at = NULL,
         lease_expires_at = NULL,
         terminal_at = decision.decided_at,
         applied_at = decision.decided_at,
         updated_at = decision.decided_at
       FROM decision
       WHERE id = $1
         AND lease_token = $2
         AND lease_generation = $3
         AND status = 'applying'
         AND lease_expires_at > decision.decided_at
       RETURNING executor_commands.*`,
      [
        acknowledgement.commandId,
        acknowledgement.leaseToken,
        acknowledgement.leaseGeneration,
        acknowledgement.sqliteReceiptHash,
        acknowledgement.resultJson
      ]
    );
    if (result.rows[0]) {
      return { outcome: "acknowledged", command: mapExecutorCommand(result.rows[0]) };
    }
    return this.classifyAppliedAcknowledgement(
      acknowledgement.commandId,
      acknowledgement.sqliteReceiptHash
    );
  }

  async acknowledgeRejected(
    input: AcknowledgeRejectedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult> {
    const acknowledgement = validateRejectedExecutorCommandAcknowledgement(input);
    const result = await this.pool.query<ExecutorCommandRow>(
      `WITH decision AS MATERIALIZED (
         SELECT clock_timestamp() AS decided_at
       )
       UPDATE executor_commands SET
         status = 'rejected',
         sqlite_receipt_hash = NULL,
         result = NULL,
         error_code = $4,
         error_message = $5,
         lease_owner = NULL,
         lease_token = NULL,
         lease_acquired_at = NULL,
         lease_expires_at = NULL,
         terminal_at = decision.decided_at,
         applied_at = NULL,
         updated_at = decision.decided_at
       FROM decision
       WHERE id = $1
         AND lease_token = $2
         AND lease_generation = $3
         AND status = 'applying'
         AND lease_expires_at > decision.decided_at
       RETURNING executor_commands.*`,
      [
        acknowledgement.commandId,
        acknowledgement.leaseToken,
        acknowledgement.leaseGeneration,
        acknowledgement.errorCode,
        acknowledgement.errorMessage
      ]
    );
    if (result.rows[0]) {
      return { outcome: "acknowledged", command: mapExecutorCommand(result.rows[0]) };
    }
    return this.classifyRejectedAcknowledgement(
      acknowledgement.commandId,
      acknowledgement.errorCode,
      acknowledgement.errorMessage
    );
  }

  /** Terminalizes only expired leases that have consumed their bounded retry budget. */
  async recoverExpiredLeases(): Promise<number> {
    const result = await this.pool.query(
      `WITH victims AS MATERIALIZED (
         SELECT id
         FROM executor_commands
         WHERE status = 'applying'
           AND lease_expires_at <= clock_timestamp()
           AND attempt >= max_attempts
         ORDER BY lease_expires_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ), decision AS MATERIALIZED (
         SELECT clock_timestamp() AS decided_at
       )
       UPDATE executor_commands command SET
         status = 'rejected',
         error_code = 'executor_attempts_exhausted',
         error_message = 'Executor command lease expired after the bounded attempt limit.',
         lease_owner = NULL,
         lease_token = NULL,
         lease_acquired_at = NULL,
         lease_expires_at = NULL,
         terminal_at = decision.decided_at,
         updated_at = decision.decided_at
       FROM victims, decision
       WHERE command.id = victims.id`,
      [EXHAUSTED_RECOVERY_BATCH_SIZE]
    );
    return result.rowCount ?? 0;
  }

  async pruneOwner(
    ownerUserId: string,
    options: ExecutorCommandRetentionOptions = {}
  ): Promise<ExecutorCommandPruneResult> {
    const owner = requireExecutorCommandUuid(ownerUserId, "ownerUserId");
    const retention = validateExecutorCommandRepositoryOptions({ ...this.options, ...options });
    return this.transaction(async (client) => {
      await this.lockOwner(client, owner);
      return pruneExecutorCommandsForOwner(client, owner, retention);
    });
  }

  private async classifyAppliedAcknowledgement(
    commandId: string,
    sqliteReceiptHash: string
  ): Promise<ExecutorCommandAcknowledgementResult> {
    const command = await this.findInternal(commandId);
    if (!command) return { outcome: "missing" };
    if (command.status === "applied") {
      return command.sqliteReceiptHash === sqliteReceiptHash
        ? { outcome: "duplicate", command }
        : { outcome: "conflict" };
    }
    if (command.status === "rejected") return { outcome: "conflict" };
    return { outcome: "stale-fence" };
  }

  private async classifyRejectedAcknowledgement(
    commandId: string,
    errorCode: string,
    errorMessage: string | null
  ): Promise<ExecutorCommandAcknowledgementResult> {
    const command = await this.findInternal(commandId);
    if (!command) return { outcome: "missing" };
    if (command.status === "rejected") {
      return command.errorCode === errorCode && command.errorMessage === errorMessage
        ? { outcome: "duplicate", command }
        : { outcome: "conflict" };
    }
    if (command.status === "applied") return { outcome: "conflict" };
    return { outcome: "stale-fence" };
  }

  private async findInternal(commandId: string): Promise<ExecutorCommand | undefined> {
    const result = await this.pool.query<ExecutorCommandRow>(
      `${selectExecutorCommandSql()} WHERE id = $1`,
      [commandId]
    );
    return result.rows[0] && mapExecutorCommand(result.rows[0]);
  }

  private async lockOwner(client: PoolClient, ownerUserId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [
      EXECUTOR_COMMAND_ADVISORY_LOCK_NAMESPACE,
      ownerUserId
    ]);
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

function isApplyingOwnerConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  return postgresError.code === "23505"
    && postgresError.constraint === "executor_commands_one_applying_per_owner";
}
