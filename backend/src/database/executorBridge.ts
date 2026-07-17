import type {
  ClaimedExecutorCommand,
  EnqueueExecutorCommandInput,
  EnqueueExecutorCommandResult,
  ExecutorCommand,
  ExecutorCommandAcknowledgementResult,
  ExecutorCommandLeaseFence
} from "./executorCommandTypes.js";
import {
  abortableBridgeDelay,
  bridgeDelay,
  ExecutorBridgeWakeSignal,
  settleBridgePromisesWithin
} from "./executorBridgeTiming.js";
import {
  ExecutorBridgeClosedError,
  type ExecutorApplyResult,
  type ExecutorAuthorizationDecision,
  type ExecutorBridge,
  type ExecutorBridgeApplyingSnapshot,
  type ExecutorBridgeCallbackContext,
  type ExecutorBridgeCloseOptions,
  type ExecutorBridgeDependencies,
  type ExecutorBridgeDrainResult,
  type ExecutorBridgeEnqueueOutcome,
  type ExecutorBridgeErrorSnapshot,
  type ExecutorBridgeLifecycle,
  type ExecutorBridgeOptions,
  type ExecutorBridgePumpResult,
  type ExecutorBridgeQueueState,
  type ExecutorBridgeReadinessSnapshot,
  type ExecutorBridgeStartupResult,
  type ExecutorBridgeWaitResult
} from "./executorBridgeTypes.js";
import {
  resolveExecutorBridgeOptions,
  validateAppliedReceiptProbeResult,
  validateAuthorizationDecision,
  validateExecutorApplyResult,
  validateExecutorBridgeWaitTimeout,
  type ResolvedExecutorBridgeOptions
} from "./executorBridgeValidation.js";

interface LeaseState {
  lost: boolean;
}

type PendingTerminalDecision =
  | { kind: "applied"; result: Extract<ExecutorApplyResult, { outcome: "applied" }> }
  | {
      kind: "rejected";
      result:
        | Extract<ExecutorApplyResult, { outcome: "rejected" }>
        | Extract<ExecutorAuthorizationDecision, { outcome: "rejected" }>;
    };

/**
 * Singleton orchestration bridge between the PostgreSQL command queue and one
 * executor-owned SQLite apply callback. It never applies without a live fence.
 */
export class FencedExecutorBridge implements ExecutorBridge {
  private readonly options: ResolvedExecutorBridgeOptions;
  private readonly wakeSignal = new ExecutorBridgeWakeSignal();
  private lifecycle: ExecutorBridgeLifecycle = "stopped";
  private queueState: ExecutorBridgeQueueState = "stopped";
  private acceptingSubmissions = true;
  private startPromise: Promise<ExecutorBridgeStartupResult> | undefined;
  private loopPromise: Promise<void> | undefined;
  private pumpPromise: Promise<ExecutorBridgePumpResult> | undefined;
  private activeApplyAbort: AbortController | undefined;
  private activeRenewalStop: AbortController | undefined;
  private applying: ExecutorBridgeApplyingSnapshot | null = null;
  private lastError: ExecutorBridgeErrorSnapshot | null = null;
  private consecutiveFailures = 0;
  private submitted = 0;
  private replayed = 0;
  private processed = 0;
  private lastClaimAt: string | null = null;
  private lastIdleAt: string | null = null;

  constructor(
    private readonly dependencies: ExecutorBridgeDependencies,
    options: ExecutorBridgeOptions
  ) {
    this.options = resolveExecutorBridgeOptions(options);
  }

  async start(): Promise<ExecutorBridgeStartupResult> {
    if (this.lifecycle === "running") {
      return { recoveredExpired: 0, alreadyRunning: true };
    }
    if (this.lifecycle === "quiescing" || this.lifecycle === "closed") {
      throw new ExecutorBridgeClosedError();
    }
    if (this.startPromise) return this.startPromise;
    const startup = this.startInternal();
    this.startPromise = startup;
    void startup.then(
      () => {
        if (this.startPromise === startup) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === startup) this.startPromise = undefined;
      }
    );
    return startup;
  }

  async submit(input: EnqueueExecutorCommandInput): Promise<EnqueueExecutorCommandResult> {
    if (!this.acceptingSubmissions) throw new ExecutorBridgeClosedError();
    const result = await this.dependencies.repository.enqueue(input);
    if (result.outcome === "enqueued") this.submitted += 1;
    else this.replayed += 1;
    this.wakeSignal.wake();
    return result;
  }

  async submitAndWait(
    input: EnqueueExecutorCommandInput,
    timeoutMs = this.options.submitWaitTimeoutMs
  ): Promise<ExecutorBridgeWaitResult> {
    const timeout = validateExecutorBridgeWaitTimeout(timeoutMs);
    if (this.lifecycle === "stopped" || this.lifecycle === "starting") await this.start();
    const submitted = await this.submit(input);
    const enqueueOutcome = submitted.outcome;
    const terminal = terminalWaitResult(submitted.command, enqueueOutcome);
    if (terminal) return terminal;

    const deadline = Date.now() + timeout;
    let current = submitted.command;
    while (Date.now() < deadline) {
      if (this.lifecycle === "closed") {
        return { outcome: "closed", enqueueOutcome, command: current };
      }
      const stored = await this.dependencies.repository.get(input.ownerUserId, submitted.command.id);
      if (!stored) {
        return { outcome: "missing", enqueueOutcome, commandId: submitted.command.id };
      }
      current = stored;
      const completed = terminalWaitResult(stored, enqueueOutcome);
      if (completed) return completed;
      const remaining = Math.max(1, deadline - Date.now());
      await bridgeDelay(Math.min(this.options.submitWaitPollMs, remaining));
    }
    return { outcome: "timeout", enqueueOutcome, command: current };
  }

  async pumpOnce(): Promise<ExecutorBridgePumpResult> {
    if (this.lifecycle === "quiescing" || this.lifecycle === "closed") {
      return { outcome: "quiesced" };
    }
    if (this.pumpPromise) return this.pumpPromise;
    const pump = this.executeNextSafely();
    this.pumpPromise = pump;
    void pump.then(
      (result) => {
        this.updateQueueStateAfterPump(result);
        if (this.pumpPromise === pump) this.pumpPromise = undefined;
      },
      () => {
        if (this.pumpPromise === pump) this.pumpPromise = undefined;
      }
    );
    return pump;
  }

  readiness(): ExecutorBridgeReadinessSnapshot {
    return {
      ready: this.lifecycle === "running" && this.queueState !== "backoff",
      lifecycle: this.lifecycle,
      acceptingSubmissions: this.acceptingSubmissions,
      queue: {
        state: this.queueState,
        submitted: this.submitted,
        replayed: this.replayed,
        processed: this.processed,
        lastClaimAt: this.lastClaimAt,
        lastIdleAt: this.lastIdleAt
      },
      applying: this.applying && { ...this.applying },
      lastError: this.lastError && { ...this.lastError }
    };
  }

  quiesce(): void {
    if (this.lifecycle === "closed") return;
    this.acceptingSubmissions = false;
    this.lifecycle = "quiescing";
    this.queueState = "quiesced";
    this.wakeSignal.wake();
  }

  async drain(timeoutMs = this.options.closeDrainTimeoutMs): Promise<ExecutorBridgeDrainResult> {
    const timeout = validateExecutorBridgeWaitTimeout(timeoutMs);
    const applyingCommandId = this.applying?.commandId ?? null;
    const pending = uniquePromises([this.startPromise, this.pumpPromise, this.loopPromise]);
    const drained = await settleBridgePromisesWithin(pending, timeout);
    return { drained, timedOut: !drained, applyingCommandId };
  }

  async close(options: ExecutorBridgeCloseOptions = {}): Promise<ExecutorBridgeDrainResult> {
    if (this.lifecycle === "closed") {
      return {
        drained: !this.pumpPromise,
        timedOut: Boolean(this.pumpPromise),
        applyingCommandId: this.applying?.commandId ?? null
      };
    }
    this.quiesce();
    const timeout = options.drainTimeoutMs ?? this.options.closeDrainTimeoutMs;
    const result = await this.drain(timeout);
    let drained = result.drained;
    if (!result.drained) {
      this.activeApplyAbort?.abort(new Error("Executor bridge close deadline elapsed"));
      this.activeRenewalStop?.abort();
      drained = (await this.drain(timeout)).drained;
    }
    if (drained) {
      this.lifecycle = "closed";
      this.queueState = "quiesced";
      this.wakeSignal.wake();
    }
    return {
      drained,
      timedOut: result.timedOut,
      applyingCommandId: result.applyingCommandId
    };
  }

  private async startInternal(): Promise<ExecutorBridgeStartupResult> {
    this.lifecycle = "starting";
    this.queueState = "reconciling";
    try {
      const recoveredExpired = await this.dependencies.repository.recoverExpiredLeases();
      if (this.lifecycle !== "starting") throw new ExecutorBridgeClosedError();
      this.lifecycle = "running";
      this.queueState = "polling";
      const loop = this.runLoop();
      this.loopPromise = loop;
      void loop.then(
        () => {
          if (this.loopPromise === loop) this.loopPromise = undefined;
        },
        (error) => {
          this.recordUnexpected("pump_loop_failed", error);
          if (this.lifecycle === "running") {
            this.lifecycle = "stopped";
            this.queueState = "backoff";
          }
          if (this.loopPromise === loop) this.loopPromise = undefined;
        }
      );
      return { recoveredExpired, alreadyRunning: false };
    } catch (error) {
      if (!(error instanceof ExecutorBridgeClosedError)) {
        this.recordUnexpected("startup_reconciliation_failed", error);
        this.lifecycle = "stopped";
        this.queueState = "stopped";
      }
      throw error;
    }
  }

  private async runLoop(): Promise<void> {
    let backoffMs = this.options.initialBackoffMs;
    while (this.lifecycle === "running") {
      const result = await this.pumpOnce();
      if (this.lifecycle !== "running") break;
      let delayMs: number;
      if (result.outcome === "retry-scheduled") {
        this.queueState = "backoff";
        delayMs = backoffMs;
        backoffMs = Math.min(this.options.maxBackoffMs, backoffMs * 2);
      } else if (result.outcome === "idle") {
        this.queueState = "idle";
        delayMs = this.options.idleIntervalMs;
        backoffMs = this.options.initialBackoffMs;
      } else {
        this.queueState = "polling";
        delayMs = this.options.busyIntervalMs;
        backoffMs = this.options.initialBackoffMs;
      }
      await this.wakeSignal.wait(delayMs);
    }
  }

  private async executeNextSafely(): Promise<ExecutorBridgePumpResult> {
    this.queueState = "polling";
    let command: ClaimedExecutorCommand | undefined;
    try {
      command = await this.dependencies.repository.claim(
        this.options.workerId,
        this.options.leaseMs
      );
    } catch (error) {
      this.recordUnexpected("queue_claim_failed", error);
      return { outcome: "retry-scheduled" };
    }
    if (!command) {
      this.consecutiveFailures = 0;
      this.lastIdleAt = this.timestamp();
      return { outcome: "idle" };
    }
    this.lastClaimAt = this.timestamp();
    try {
      return await this.executeClaimed(command);
    } catch (error) {
      this.recordUnexpected("claimed_command_failed", error);
      return { outcome: "retry-scheduled", commandId: command.id };
    }
  }

  private async executeClaimed(command: ClaimedExecutorCommand): Promise<ExecutorBridgePumpResult> {
    const fence: ExecutorCommandLeaseFence = {
      commandId: command.id,
      leaseToken: command.leaseToken,
      leaseGeneration: command.leaseGeneration
    };
    const applyAbort = new AbortController();
    const renewalStop = new AbortController();
    const leaseState: LeaseState = { lost: false };
    this.activeApplyAbort = applyAbort;
    this.activeRenewalStop = renewalStop;
    this.queueState = "applying";
    this.applying = applyingSnapshot(command, this.timestamp());
    const renewal = this.maintainLease(fence, renewalStop.signal, applyAbort, leaseState);
    let decision: PendingTerminalDecision | undefined;
    let operationError: unknown;

    try {
      const context = callbackContext(command, applyAbort.signal);
      const priorReceipt = context.recovered
        ? validateAppliedReceiptProbeResult(
            await this.dependencies.probeAppliedReceipt(receiptProbeIdentity(command), context)
          )
        : { outcome: "not-found" as const };
      if (priorReceipt.outcome === "applied") {
        decision = {
          kind: "applied",
          result: {
            outcome: "applied",
            sqliteReceiptHash: priorReceipt.sqliteReceiptHash
          }
        };
      } else {
        const authorization = validateAuthorizationDecision(
          await this.dependencies.authorize(command, context)
        );
        if (authorization.outcome === "rejected") {
          decision = { kind: "rejected", result: authorization };
        } else {
          const result = validateExecutorApplyResult(
            await this.dependencies.apply(command, context)
          );
          decision = result.outcome === "applied"
            ? { kind: "applied", result }
            : { kind: "rejected", result };
        }
      }
    } catch (error) {
      operationError = error;
    } finally {
      renewalStop.abort();
      await renewal;
    }

    try {
      if (leaseState.lost) return { outcome: "stale-fence", commandId: command.id };
      if (operationError !== undefined) {
        if (applyAbort.signal.aborted && this.lifecycle === "closed") {
          return { outcome: "quiesced" };
        }
        this.recordUnexpected("executor_callback_failed", operationError);
        return { outcome: "retry-scheduled", commandId: command.id };
      }
      if (!decision) {
        this.recordUnexpected("executor_callback_failed", new Error("missing decision"));
        return { outcome: "retry-scheduled", commandId: command.id };
      }
      if (applyAbort.signal.aborted && this.lifecycle === "closed") {
        return { outcome: "quiesced" };
      }
      try {
        const acknowledgement = decision.kind === "applied"
          ? await this.dependencies.repository.acknowledgeApplied({
              ...fence,
              sqliteReceiptHash: decision.result.sqliteReceiptHash,
              ...(decision.result.result ? { result: decision.result.result } : {})
            })
          : await this.dependencies.repository.acknowledgeRejected({
              ...fence,
              errorCode: decision.result.errorCode,
              ...(decision.result.errorMessage
                ? { errorMessage: decision.result.errorMessage }
                : {})
            });
        return this.mapAcknowledgement(command.id, decision.kind, acknowledgement);
      } catch (error) {
        this.recordUnexpected("postgres_acknowledgement_failed", error);
        return { outcome: "retry-scheduled", commandId: command.id };
      }
    } finally {
      if (this.activeApplyAbort === applyAbort) this.activeApplyAbort = undefined;
      if (this.activeRenewalStop === renewalStop) this.activeRenewalStop = undefined;
      this.applying = null;
    }
  }

  private async maintainLease(
    fence: ExecutorCommandLeaseFence,
    stopSignal: AbortSignal,
    applyAbort: AbortController,
    state: LeaseState
  ): Promise<void> {
    while (await abortableBridgeDelay(this.options.renewalIntervalMs, stopSignal)) {
      try {
        const renewed = await this.dependencies.repository.renewLease(
          fence,
          this.options.leaseMs
        );
        if (renewed) continue;
        state.lost = true;
        this.recordFailure("stale_lease_fence", "Executor command lease ownership was lost.");
      } catch (error) {
        state.lost = true;
        this.recordUnexpected("lease_renewal_failed", error);
      }
      applyAbort.abort(new Error("Executor command lease ownership was lost"));
      return;
    }
  }

  private mapAcknowledgement(
    commandId: string,
    kind: "applied" | "rejected",
    acknowledgement: ExecutorCommandAcknowledgementResult
  ): ExecutorBridgePumpResult {
    if (acknowledgement.outcome === "acknowledged" || acknowledgement.outcome === "duplicate") {
      this.processed += 1;
      this.consecutiveFailures = 0;
      return kind === "applied"
        ? { outcome: "applied", command: acknowledgement.command }
        : { outcome: "rejected", command: acknowledgement.command };
    }
    if (acknowledgement.outcome === "stale-fence") {
      this.recordFailure("stale_lease_fence", "Executor command lease ownership was lost.");
      return { outcome: "stale-fence", commandId };
    }
    if (acknowledgement.outcome === "conflict") {
      this.recordFailure("command_ack_conflict", "Executor command acknowledgement conflicted.");
      return { outcome: "conflict", commandId };
    }
    this.recordFailure("command_missing", "Executor command disappeared before acknowledgement.");
    return { outcome: "missing", commandId };
  }

  private recordUnexpected(code: string, _error: unknown): void {
    this.recordFailure(code, "Unexpected executor bridge operation failed.");
  }

  private recordFailure(code: string, message: string): void {
    this.consecutiveFailures += 1;
    this.lastError = {
      code,
      message,
      occurredAt: this.timestamp(),
      consecutiveFailures: this.consecutiveFailures
    };
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  private updateQueueStateAfterPump(result: ExecutorBridgePumpResult): void {
    if (this.lifecycle === "quiescing" || this.lifecycle === "closed") {
      this.queueState = "quiesced";
    } else if (result.outcome === "retry-scheduled") {
      this.queueState = "backoff";
    } else if (result.outcome === "idle") {
      this.queueState = "idle";
    } else {
      this.queueState = "polling";
    }
  }
}

function receiptProbeIdentity(command: ClaimedExecutorCommand) {
  return {
    commandId: command.id,
    ownerUserId: command.ownerUserId,
    idempotencyKey: command.idempotencyKey,
    requestHash: command.requestHash
  };
}

function callbackContext(
  command: ClaimedExecutorCommand,
  signal: AbortSignal
): ExecutorBridgeCallbackContext {
  return {
    signal,
    attempt: command.attempt,
    leaseGeneration: command.leaseGeneration,
    recovered: command.attempt > 1
  };
}

function applyingSnapshot(
  command: ClaimedExecutorCommand,
  startedAt: string
): ExecutorBridgeApplyingSnapshot {
  return {
    commandId: command.id,
    ownerUserId: command.ownerUserId,
    commandType: command.commandType,
    targetType: command.targetType,
    targetId: command.targetId,
    attempt: command.attempt,
    leaseGeneration: command.leaseGeneration,
    startedAt
  };
}

function terminalWaitResult(
  command: ExecutorCommand,
  enqueueOutcome: ExecutorBridgeEnqueueOutcome
): ExecutorBridgeWaitResult | undefined {
  if (command.status === "applied") return { outcome: "applied", enqueueOutcome, command };
  if (command.status === "rejected") return { outcome: "rejected", enqueueOutcome, command };
  return undefined;
}

function uniquePromises(
  values: readonly (Promise<unknown> | undefined)[]
): Promise<unknown>[] {
  return [...new Set(values.filter((value): value is Promise<unknown> => Boolean(value)))];
}
