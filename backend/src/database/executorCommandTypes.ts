export const EXECUTOR_COMMAND_STATUSES = ["queued", "applying", "applied", "rejected"] as const;
export type ExecutorCommandStatus = (typeof EXECUTOR_COMMAND_STATUSES)[number];

export const DEFAULT_EXECUTOR_COMMAND_LEASE_MS = 30_000;
export const MAX_EXECUTOR_COMMAND_LEASE_MS = 5 * 60_000;
export const DEFAULT_EXECUTOR_COMMAND_MAX_ATTEMPTS = 8;
export const MAX_EXECUTOR_COMMAND_ATTEMPTS = 32;
export const DEFAULT_EXECUTOR_COMMAND_MAX_ACTIVE_PER_OWNER = 256;
export const DEFAULT_EXECUTOR_COMMAND_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_EXECUTOR_COMMAND_MAX_TERMINAL_PER_OWNER = 10_000;
export const DEFAULT_EXECUTOR_COMMAND_PRUNE_BATCH_SIZE = 1_000;
export const MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES = 32 * 1_024;
export const MAX_EXECUTOR_COMMAND_RESULT_BYTES = 16 * 1_024;
export const MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS = 4_000;

export interface ExecutorCommand {
  readonly id: string;
  readonly ownerUserId: string;
  readonly actorUserId: string | null;
  readonly sessionIdHash: string;
  readonly authorizationRevision: number;
  readonly authorizationEpoch: number;
  readonly commandType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly payload: Record<string, unknown>;
  readonly status: ExecutorCommandStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseGeneration: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseAcquiredAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly sqliteReceiptHash: string | null;
  readonly result: Record<string, unknown> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly terminalAt: Date | null;
  readonly appliedAt: Date | null;
}

export interface ClaimedExecutorCommand extends ExecutorCommand {
  readonly status: "applying";
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseAcquiredAt: Date;
  readonly leaseExpiresAt: Date;
}

export interface EnqueueExecutorCommandInput {
  readonly ownerUserId: string;
  readonly actorUserId?: string | null;
  readonly sessionIdHash: string;
  readonly authorizationRevision: number;
  readonly authorizationEpoch: number;
  readonly commandType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
  /** Lowercase SHA-256 of the complete validated request at its HTTP boundary. */
  readonly requestHash: string;
  readonly payload: Record<string, unknown>;
}

export type EnqueueExecutorCommandResult =
  | { readonly outcome: "enqueued"; readonly command: ExecutorCommand }
  | { readonly outcome: "replayed"; readonly command: ExecutorCommand };

export interface ExecutorCommandLeaseFence {
  readonly commandId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface AcknowledgeAppliedExecutorCommandInput extends ExecutorCommandLeaseFence {
  /** Digest read from the executor-owned SQLite receipt for this exact command ID. */
  readonly sqliteReceiptHash: string;
  readonly result?: Record<string, unknown>;
}

export interface AcknowledgeRejectedExecutorCommandInput extends ExecutorCommandLeaseFence {
  readonly errorCode: string;
  readonly errorMessage?: string;
}

export type ExecutorCommandAcknowledgementResult =
  | { readonly outcome: "acknowledged"; readonly command: ExecutorCommand }
  | { readonly outcome: "duplicate"; readonly command: ExecutorCommand }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "stale-fence" }
  | { readonly outcome: "missing" };

export interface ExecutorCommandRetentionOptions {
  readonly terminalRetentionMs?: number;
  readonly maxTerminalPerOwner?: number;
  readonly pruneBatchSize?: number;
}

export interface ExecutorCommandRepositoryOptions extends ExecutorCommandRetentionOptions {
  readonly maxActivePerOwner?: number;
  readonly maxAttempts?: number;
}

export interface ExecutorCommandPruneResult {
  readonly deletedByAge: number;
  readonly deletedByCount: number;
}

export interface ExecutorCommandRepository {
  enqueue(input: EnqueueExecutorCommandInput): Promise<EnqueueExecutorCommandResult>;
  get(ownerUserId: string, commandId: string): Promise<ExecutorCommand | undefined>;
  list(ownerUserId: string, limit?: number): Promise<ExecutorCommand[]>;
  claim(workerId: string, leaseMs?: number): Promise<ClaimedExecutorCommand | undefined>;
  renewLease(fence: ExecutorCommandLeaseFence, leaseMs?: number): Promise<boolean>;
  acknowledgeApplied(
    input: AcknowledgeAppliedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult>;
  acknowledgeRejected(
    input: AcknowledgeRejectedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult>;
  recoverExpiredLeases(): Promise<number>;
  pruneOwner(
    ownerUserId: string,
    options?: ExecutorCommandRetentionOptions
  ): Promise<ExecutorCommandPruneResult>;
}

export class ExecutorCommandIdempotencyConflictError extends Error {
  constructor() {
    super("The Idempotency-Key is already associated with a different executor command request.");
    this.name = "ExecutorCommandIdempotencyConflictError";
  }
}

export class ExecutorCommandCapacityError extends Error {
  constructor(readonly maxActivePerOwner: number) {
    super(`Executor command capacity is exhausted for this owner (${maxActivePerOwner}).`);
    this.name = "ExecutorCommandCapacityError";
  }
}
