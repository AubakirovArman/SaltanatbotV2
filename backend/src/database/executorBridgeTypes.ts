import type {
  ClaimedExecutorCommand,
  EnqueueExecutorCommandInput,
  EnqueueExecutorCommandResult,
  ExecutorCommand,
  ExecutorCommandRepository
} from "./executorCommandTypes.js";

export type ExecutorBridgeLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "quiescing"
  | "closed";

export type ExecutorBridgeQueueState =
  | "stopped"
  | "reconciling"
  | "polling"
  | "idle"
  | "applying"
  | "backoff"
  | "quiesced";

export interface ExecutorBridgeErrorSnapshot {
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly consecutiveFailures: number;
}

export interface ExecutorBridgeApplyingSnapshot {
  readonly commandId: string;
  readonly ownerUserId: string;
  readonly commandType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly startedAt: string;
}

export interface ExecutorBridgeReadinessSnapshot {
  readonly ready: boolean;
  readonly lifecycle: ExecutorBridgeLifecycle;
  readonly acceptingSubmissions: boolean;
  readonly queue: {
    readonly state: ExecutorBridgeQueueState;
    readonly submitted: number;
    readonly replayed: number;
    readonly processed: number;
    readonly lastClaimAt: string | null;
    readonly lastIdleAt: string | null;
  };
  readonly applying: ExecutorBridgeApplyingSnapshot | null;
  readonly lastError: ExecutorBridgeErrorSnapshot | null;
}

export interface ExecutorBridgeCallbackContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly leaseGeneration: number;
  /** True when PostgreSQL reclaimed a command after an earlier executor attempt. */
  readonly recovered: boolean;
}

/**
 * Minimal identity exposed to the executor-owned receipt store before
 * authorization. Deliberately excludes payload, session and authorization
 * details so reconciliation cannot become a secret-reading side channel.
 */
export interface ExecutorAppliedReceiptProbeIdentity {
  readonly commandId: string;
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type ExecutorAppliedReceiptProbeResult =
  | { readonly outcome: "not-found" }
  | {
      readonly outcome: "applied";
      readonly sqliteReceiptHash: string;
    };

export type ExecutorAuthorizationDecision =
  | { readonly outcome: "authorized" }
  | {
      readonly outcome: "rejected";
      readonly errorCode: string;
      readonly errorMessage?: string;
    };

export type ExecutorApplyResult =
  | {
      readonly outcome: "applied";
      /** Digest read from the executor-owned SQLite receipt for the command ID. */
      readonly sqliteReceiptHash: string;
      readonly result?: Record<string, unknown>;
    }
  | {
      readonly outcome: "rejected";
      readonly errorCode: string;
      readonly errorMessage?: string;
    };

export type ExecutorAuthorizationValidator = (
  command: ClaimedExecutorCommand,
  context: ExecutorBridgeCallbackContext
) => Promise<ExecutorAuthorizationDecision>;

export type ExecutorCommandApply = (
  command: ClaimedExecutorCommand,
  context: ExecutorBridgeCallbackContext
) => Promise<ExecutorApplyResult>;

export type ExecutorAppliedReceiptProbe = (
  identity: ExecutorAppliedReceiptProbeIdentity,
  context: ExecutorBridgeCallbackContext
) => Promise<ExecutorAppliedReceiptProbeResult>;

export interface ExecutorBridgeOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly renewalIntervalMs?: number;
  readonly idleIntervalMs?: number;
  readonly busyIntervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly submitWaitPollMs?: number;
  readonly submitWaitTimeoutMs?: number;
  readonly closeDrainTimeoutMs?: number;
}

export interface ExecutorBridgeDependencies {
  readonly repository: ExecutorCommandRepository;
  /**
   * Reconciles only an exact, already-applied durable receipt on a reclaimed
   * command. Implementations must match owner, command ID, idempotency key and
   * request hash; a missing/mismatched receipt must return `not-found`.
   */
  readonly probeAppliedReceipt: ExecutorAppliedReceiptProbe;
  readonly authorize: ExecutorAuthorizationValidator;
  readonly apply: ExecutorCommandApply;
}

export interface ExecutorBridgeStartupResult {
  readonly recoveredExpired: number;
  readonly alreadyRunning: boolean;
}

export type ExecutorBridgePumpResult =
  | { readonly outcome: "idle" }
  | { readonly outcome: "applied"; readonly command: ExecutorCommand }
  | { readonly outcome: "rejected"; readonly command: ExecutorCommand }
  | { readonly outcome: "stale-fence"; readonly commandId: string }
  | { readonly outcome: "conflict"; readonly commandId: string }
  | { readonly outcome: "missing"; readonly commandId: string }
  | { readonly outcome: "retry-scheduled"; readonly commandId?: string }
  | { readonly outcome: "quiesced" };

export type ExecutorBridgeEnqueueOutcome = EnqueueExecutorCommandResult["outcome"];

export type ExecutorBridgeWaitResult =
  | {
      readonly outcome: "applied";
      readonly enqueueOutcome: ExecutorBridgeEnqueueOutcome;
      readonly command: ExecutorCommand;
    }
  | {
      readonly outcome: "rejected";
      readonly enqueueOutcome: ExecutorBridgeEnqueueOutcome;
      readonly command: ExecutorCommand;
    }
  | {
      readonly outcome: "timeout";
      readonly enqueueOutcome: ExecutorBridgeEnqueueOutcome;
      readonly command: ExecutorCommand;
    }
  | {
      readonly outcome: "closed";
      readonly enqueueOutcome: ExecutorBridgeEnqueueOutcome;
      readonly command: ExecutorCommand;
    }
  | {
      readonly outcome: "missing";
      readonly enqueueOutcome: ExecutorBridgeEnqueueOutcome;
      readonly commandId: string;
    };

export interface ExecutorBridgeDrainResult {
  readonly drained: boolean;
  readonly timedOut: boolean;
  readonly applyingCommandId: string | null;
}

export interface ExecutorBridgeCloseOptions {
  readonly drainTimeoutMs?: number;
}

export interface ExecutorBridge {
  start(): Promise<ExecutorBridgeStartupResult>;
  submit(input: EnqueueExecutorCommandInput): Promise<EnqueueExecutorCommandResult>;
  submitAndWait(
    input: EnqueueExecutorCommandInput,
    timeoutMs?: number
  ): Promise<ExecutorBridgeWaitResult>;
  pumpOnce(): Promise<ExecutorBridgePumpResult>;
  readiness(): ExecutorBridgeReadinessSnapshot;
  quiesce(): void;
  drain(timeoutMs?: number): Promise<ExecutorBridgeDrainResult>;
  close(options?: ExecutorBridgeCloseOptions): Promise<ExecutorBridgeDrainResult>;
}

export class ExecutorBridgeClosedError extends Error {
  constructor() {
    super("The executor bridge is quiescing or closed.");
    this.name = "ExecutorBridgeClosedError";
  }
}
