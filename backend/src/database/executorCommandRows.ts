import type { ExecutorCommand, ExecutorCommandStatus } from "./executorCommandTypes.js";
import { executorCommandSafeInteger } from "./executorCommandValidation.js";

export interface ExecutorCommandRow {
  id: string;
  owner_user_id: string;
  actor_user_id: string | null;
  session_id_hash: string;
  authorization_revision: string;
  authorization_epoch: string;
  command_type: string;
  target_type: string;
  target_id: string;
  idempotency_key: string;
  request_hash: string;
  payload: Record<string, unknown>;
  status: ExecutorCommandStatus;
  attempt: number;
  max_attempts: number;
  lease_generation: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_acquired_at: Date | null;
  lease_expires_at: Date | null;
  sqlite_receipt_hash: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  terminal_at: Date | null;
  applied_at: Date | null;
}

export function selectExecutorCommandSql(): string {
  return `SELECT
    id, owner_user_id, actor_user_id, session_id_hash,
    authorization_revision, authorization_epoch,
    command_type, target_type, target_id, idempotency_key, request_hash,
    payload, status, attempt, max_attempts, lease_generation,
    lease_owner, lease_token, lease_acquired_at, lease_expires_at,
    sqlite_receipt_hash, result, error_code, error_message,
    created_at, updated_at, terminal_at, applied_at
  FROM executor_commands`;
}

export function mapExecutorCommand(row: ExecutorCommandRow): ExecutorCommand {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    actorUserId: row.actor_user_id,
    sessionIdHash: row.session_id_hash,
    authorizationRevision: executorCommandSafeInteger(
      row.authorization_revision,
      "authorization revision"
    ),
    authorizationEpoch: executorCommandSafeInteger(
      row.authorization_epoch,
      "authorization epoch"
    ),
    commandType: row.command_type,
    targetType: row.target_type,
    targetId: row.target_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    payload: row.payload,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseGeneration: executorCommandSafeInteger(row.lease_generation, "lease generation"),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseAcquiredAt: row.lease_acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    sqliteReceiptHash: row.sqlite_receipt_hash,
    result: row.result,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    appliedAt: row.applied_at
  };
}
