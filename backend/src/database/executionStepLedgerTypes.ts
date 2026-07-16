export const EXECUTION_STEP_OPERATION_KINDS = [
  "bot",
  "manual",
  "emergency",
  "reconciliation"
] as const;
export type ExecutionStepOperationKind = (typeof EXECUTION_STEP_OPERATION_KINDS)[number];
export type ExecutionStepLedgerStatus = "reserved" | "consumed" | "expired";

export const DEFAULT_EXECUTION_STEP_RESERVATION_TTL_MS = 60_000;
export const DEFAULT_EXECUTION_STEP_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_EXECUTION_STEP_MAX_TERMINAL_ROWS_PER_OWNER = 10_000;
export const DEFAULT_EXECUTION_STEP_MAX_ACTIVE_PER_OWNER = 256;
export const DEFAULT_EXECUTION_STEP_RECONCILIATION_ACTIVE_HEADROOM = 24;
export const DEFAULT_EXECUTION_STEP_EMERGENCY_ACTIVE_HEADROOM = 8;
export const DEFAULT_EXECUTION_STEP_MAX_DURABLE_KEYS_PER_OWNER = 240_000;
export const DEFAULT_EXECUTION_STEP_RECONCILIATION_DURABLE_HEADROOM = 8_000;
export const DEFAULT_EXECUTION_STEP_EMERGENCY_DURABLE_HEADROOM = 2_000;
export const MAX_EXECUTION_STEP_DURABLE_KEYS_PER_OWNER = 250_000;
export const DEFAULT_EXECUTION_STEP_PRUNE_BATCH_SIZE = 1_000;

/** Compact idempotency key retained for the lifetime of its owner. */
export interface ExecutionStepLedgerKey {
  readonly ownerUserId: string;
  /** Unique stable identity of one signed step (entry, SL and TP use different IDs). */
  readonly intentId: string;
  readonly intentDigest: string;
  readonly signedRequestDigest: string;
  readonly bindingDigest: string;
  readonly createdAt: Date;
}

/** Mutable reservation detail. Terminal rows are subject to bounded retention. */
export interface ExecutionStepLedgerRecord extends ExecutionStepLedgerKey {
  readonly accountId: string;
  readonly operationKind: ExecutionStepOperationKind;
  readonly operationId: string;
  readonly accountRevision: number;
  readonly credentialRevision: number;
  readonly authorizationRevision: number;
  readonly authorizationEpoch: number;
  readonly liveArmEpoch: number;
  readonly status: ExecutionStepLedgerStatus;
  readonly reservationId: string;
  readonly reservedAt: Date;
  readonly reservationExpiresAt: Date;
  readonly consumedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly reservationCreatedAt: Date;
  readonly updatedAt: Date;
}

export interface ReserveExecutionStepInput {
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly operationKind: ExecutionStepOperationKind;
  /** Groups related steps; it is not the exact-step idempotency key. */
  readonly operationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly signedRequestDigest: string;
  readonly bindingDigest: string;
  readonly accountRevision: number;
  readonly credentialRevision: number;
  readonly authorizationRevision: number;
  readonly authorizationEpoch: number;
  readonly liveArmEpoch: number;
  readonly reservationTtlMs?: number;
}

export type ReserveExecutionStepResult =
  | { readonly outcome: "reserved"; readonly record: ExecutionStepLedgerRecord }
  | {
      readonly outcome: "duplicate";
      readonly key: ExecutionStepLedgerKey;
      readonly record?: ExecutionStepLedgerRecord;
    }
  | {
      readonly outcome: "conflict";
      readonly conflictOn: "intent" | "binding" | "intent-and-binding";
    };

export interface ConsumeExecutionStepInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly reservationId: string;
  readonly bindingDigest: string;
}

export type ConsumeExecutionStepResult =
  | { readonly outcome: "consumed"; readonly record: ExecutionStepLedgerRecord }
  | { readonly outcome: "duplicate"; readonly status: "consumed" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "tombstone" }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "missing" };

export interface ExecutionStepLedgerRetentionOptions {
  readonly terminalRetentionMs?: number;
  readonly maxTerminalRowsPerOwner?: number;
  readonly batchSize?: number;
}

export interface ExecutionStepLedgerRepositoryOptions extends ExecutionStepLedgerRetentionOptions {
  readonly defaultReservationTtlMs?: number;
  readonly maxReservationTtlMs?: number;
  readonly maxActivePerOwner?: number;
  readonly reconciliationActiveHeadroom?: number;
  readonly emergencyActiveHeadroom?: number;
  readonly maxDurableKeysPerOwner?: number;
  readonly reconciliationDurableHeadroom?: number;
  readonly emergencyDurableHeadroom?: number;
}

export interface ExecutionStepLedgerPruneResult {
  readonly expired: number;
  readonly deletedByAge: number;
  readonly deletedByCount: number;
}

export interface ExecutionStepLedgerRepository {
  reserve(input: ReserveExecutionStepInput): Promise<ReserveExecutionStepResult>;
  consume(input: ConsumeExecutionStepInput): Promise<ConsumeExecutionStepResult>;
  pruneOwner(
    ownerUserId: string,
    options?: ExecutionStepLedgerRetentionOptions
  ): Promise<ExecutionStepLedgerPruneResult>;
}

export class ExecutionStepLedgerCapacityError extends Error {
  constructor(readonly maxActivePerOwner: number) {
    super(`Execution step reservation capacity is exhausted for this owner (${maxActivePerOwner}).`);
    this.name = "ExecutionStepLedgerCapacityError";
  }
}

export class ExecutionStepLedgerDurableCapacityError extends Error {
  constructor(readonly maxDurableKeysPerOwner: number) {
    super(`Durable execution step capacity is exhausted for this owner (${maxDurableKeysPerOwner}).`);
    this.name = "ExecutionStepLedgerDurableCapacityError";
  }
}
