import { randomUUID } from "node:crypto";
import {
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
  type ExecutorCommandRetentionOptions
} from "../../src/database/executorCommandTypes.js";

type AcknowledgementHook = "throw" | "stale-fence" | "conflict" | "missing";

export class ExecutorCommandRepositoryDouble implements ExecutorCommandRepository {
  readonly commands = new Map<string, ExecutorCommand>();
  readonly idempotency = new Map<string, string>();
  recoverCalls = 0;
  claimCalls = 0;
  renewCalls = 0;
  appliedAcknowledgementCalls = 0;
  rejectedAcknowledgementCalls = 0;
  nextAppliedAcknowledgement: AcknowledgementHook | undefined;
  nextRejectedAcknowledgement: AcknowledgementHook | undefined;
  nextClaimError: Error | undefined;
  nextRenewal: boolean | Error | undefined;

  constructor(
    readonly maxAttempts = 3,
    private readonly now: () => number = Date.now
  ) {}

  async enqueue(input: EnqueueExecutorCommandInput): Promise<EnqueueExecutorCommandResult> {
    const key = `${input.ownerUserId}\u0000${input.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.commands.get(existingId)!;
      if (existing.requestHash !== input.requestHash) {
        throw new ExecutorCommandIdempotencyConflictError();
      }
      return { outcome: "replayed", command: cloneCommand(existing) };
    }
    const timestamp = new Date(this.now());
    const command: ExecutorCommand = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      actorUserId: input.actorUserId ?? null,
      sessionIdHash: input.sessionIdHash,
      authorizationRevision: input.authorizationRevision,
      authorizationEpoch: input.authorizationEpoch,
      commandType: input.commandType,
      targetType: input.targetType,
      targetId: input.targetId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      payload: structuredClone(input.payload),
      status: "queued",
      attempt: 0,
      maxAttempts: this.maxAttempts,
      leaseGeneration: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      sqliteReceiptHash: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: null,
      appliedAt: null
    };
    this.commands.set(command.id, command);
    this.idempotency.set(key, command.id);
    return { outcome: "enqueued", command: cloneCommand(command) };
  }

  async get(ownerUserId: string, commandId: string): Promise<ExecutorCommand | undefined> {
    const command = this.commands.get(commandId);
    return command?.ownerUserId === ownerUserId ? cloneCommand(command) : undefined;
  }

  async list(ownerUserId: string, limit = 50): Promise<ExecutorCommand[]> {
    return [...this.commands.values()]
      .filter((command) => command.ownerUserId === ownerUserId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map(cloneCommand);
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<ClaimedExecutorCommand | undefined> {
    this.claimCalls += 1;
    if (this.nextClaimError) {
      const error = this.nextClaimError;
      this.nextClaimError = undefined;
      throw error;
    }
    const now = this.now();
    const applyingOwners = new Set(
      [...this.commands.values()]
        .filter((command) => command.status === "applying")
        .map((command) => command.ownerUserId)
    );
    const command = [...this.commands.values()]
      .filter((candidate) =>
        candidate.attempt < candidate.maxAttempts
        && (
          (
            candidate.status === "applying"
            && (candidate.leaseExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) <= now
          )
          || (
            candidate.status === "queued"
            && !applyingOwners.has(candidate.ownerUserId)
          )
        )
      )
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === "applying" ? -1 : 1;
        return left.createdAt.getTime() - right.createdAt.getTime();
      })[0];
    if (!command) return undefined;
    const acquiredAt = new Date(now);
    const claimed: ExecutorCommand = {
      ...command,
      status: "applying",
      attempt: command.attempt + 1,
      leaseGeneration: command.leaseGeneration + 1,
      leaseOwner: workerId,
      leaseToken: randomUUID(),
      leaseAcquiredAt: acquiredAt,
      leaseExpiresAt: new Date(now + leaseMs),
      updatedAt: acquiredAt
    };
    this.commands.set(command.id, claimed);
    return cloneClaimed(claimed);
  }

  async renewLease(fence: ExecutorCommandLeaseFence, leaseMs = 30_000): Promise<boolean> {
    this.renewCalls += 1;
    if (this.nextRenewal instanceof Error) {
      const error = this.nextRenewal;
      this.nextRenewal = undefined;
      throw error;
    }
    if (this.nextRenewal === false) {
      this.nextRenewal = undefined;
      return false;
    }
    const command = this.commands.get(fence.commandId);
    if (!isCurrentFence(command, fence, this.now())) return false;
    this.commands.set(command.id, {
      ...command,
      leaseExpiresAt: new Date(this.now() + leaseMs),
      updatedAt: new Date(this.now())
    });
    return true;
  }

  async acknowledgeApplied(
    input: AcknowledgeAppliedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult> {
    this.appliedAcknowledgementCalls += 1;
    const hook = this.nextAppliedAcknowledgement;
    this.nextAppliedAcknowledgement = undefined;
    if (hook) return this.hookedAcknowledgement(hook);
    const command = this.commands.get(input.commandId);
    if (!command) return { outcome: "missing" };
    if (command.status === "applied") {
      return command.sqliteReceiptHash === input.sqliteReceiptHash
        ? { outcome: "duplicate", command: cloneCommand(command) }
        : { outcome: "conflict" };
    }
    if (command.status === "rejected") return { outcome: "conflict" };
    if (!isCurrentFence(command, input, this.now())) return { outcome: "stale-fence" };
    const terminalAt = new Date(this.now());
    const applied: ExecutorCommand = {
      ...command,
      status: "applied",
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      sqliteReceiptHash: input.sqliteReceiptHash,
      result: input.result ? structuredClone(input.result) : null,
      terminalAt,
      appliedAt: terminalAt,
      updatedAt: terminalAt
    };
    this.commands.set(command.id, applied);
    return { outcome: "acknowledged", command: cloneCommand(applied) };
  }

  async acknowledgeRejected(
    input: AcknowledgeRejectedExecutorCommandInput
  ): Promise<ExecutorCommandAcknowledgementResult> {
    this.rejectedAcknowledgementCalls += 1;
    const hook = this.nextRejectedAcknowledgement;
    this.nextRejectedAcknowledgement = undefined;
    if (hook) return this.hookedAcknowledgement(hook);
    const command = this.commands.get(input.commandId);
    if (!command) return { outcome: "missing" };
    if (command.status === "rejected") {
      return command.errorCode === input.errorCode
        && command.errorMessage === (input.errorMessage ?? null)
        ? { outcome: "duplicate", command: cloneCommand(command) }
        : { outcome: "conflict" };
    }
    if (command.status === "applied") return { outcome: "conflict" };
    if (!isCurrentFence(command, input, this.now())) return { outcome: "stale-fence" };
    const terminalAt = new Date(this.now());
    const rejected: ExecutorCommand = {
      ...command,
      status: "rejected",
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage ?? null,
      terminalAt,
      appliedAt: null,
      updatedAt: terminalAt
    };
    this.commands.set(command.id, rejected);
    return { outcome: "acknowledged", command: cloneCommand(rejected) };
  }

  async recoverExpiredLeases(): Promise<number> {
    this.recoverCalls += 1;
    let recovered = 0;
    for (const command of this.commands.values()) {
      if (
        command.status !== "applying"
        || (command.leaseExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) > this.now()
        || command.attempt < command.maxAttempts
      ) continue;
      const terminalAt = new Date(this.now());
      this.commands.set(command.id, {
        ...command,
        status: "rejected",
        leaseOwner: null,
        leaseToken: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        errorCode: "executor_attempts_exhausted",
        errorMessage: "Executor command lease expired after the bounded attempt limit.",
        terminalAt,
        updatedAt: terminalAt
      });
      recovered += 1;
    }
    return recovered;
  }

  async pruneOwner(
    _ownerUserId: string,
    _options?: ExecutorCommandRetentionOptions
  ): Promise<ExecutorCommandPruneResult> {
    return { deletedByAge: 0, deletedByCount: 0 };
  }

  expire(commandId: string): void {
    const command = this.commands.get(commandId);
    if (!command || command.status !== "applying") throw new Error("Command is not applying");
    this.commands.set(commandId, { ...command, leaseExpiresAt: new Date(0) });
  }

  inspect(commandId: string): ExecutorCommand | undefined {
    const command = this.commands.get(commandId);
    return command && cloneCommand(command);
  }

  private hookedAcknowledgement(hook: AcknowledgementHook): ExecutorCommandAcknowledgementResult {
    if (hook === "throw") throw new Error("injected acknowledgement transport failure");
    return { outcome: hook };
  }
}

function isCurrentFence(
  command: ExecutorCommand | undefined,
  fence: ExecutorCommandLeaseFence,
  now: number
): command is ExecutorCommand {
  return Boolean(
    command
    && command.status === "applying"
    && command.leaseToken === fence.leaseToken
    && command.leaseGeneration === fence.leaseGeneration
    && (command.leaseExpiresAt?.getTime() ?? 0) > now
  );
}

function cloneClaimed(command: ExecutorCommand): ClaimedExecutorCommand {
  const cloned = cloneCommand(command);
  if (
    cloned.status !== "applying"
    || !cloned.leaseOwner
    || !cloned.leaseToken
    || !cloned.leaseAcquiredAt
    || !cloned.leaseExpiresAt
  ) throw new Error("Invalid claimed command double");
  return {
    ...cloned,
    status: "applying",
    leaseOwner: cloned.leaseOwner,
    leaseToken: cloned.leaseToken,
    leaseAcquiredAt: cloned.leaseAcquiredAt,
    leaseExpiresAt: cloned.leaseExpiresAt
  };
}

function cloneCommand(command: ExecutorCommand): ExecutorCommand {
  return structuredClone(command);
}
