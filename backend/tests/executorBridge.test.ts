import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FencedExecutorBridge } from "../src/database/executorBridge.js";
import {
  ExecutorBridgeClosedError,
  type ExecutorApplyResult,
  type ExecutorAuthorizationValidator,
  type ExecutorBridge,
  type ExecutorBridgeDependencies,
  type ExecutorBridgeOptions
} from "../src/database/executorBridgeTypes.js";
import {
  ExecutorCommandIdempotencyConflictError,
  type EnqueueExecutorCommandInput
} from "../src/database/executorCommandTypes.js";
import { ExecutorCommandRepositoryDouble } from "./support/executorCommandRepositoryDouble.js";

const bridges: ExecutorBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close({ drainTimeoutMs: 25 })));
});

describe("fenced executor bridge", () => {
  it("replays the same owner request and propagates an idempotency hash conflict", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const apply = vi.fn(async () => applied("receipt-replay"));
    const bridge = createBridge(repository, { apply });

    const first = await bridge.submit(commandInput());
    const replay = await bridge.submit(commandInput());
    expect(first).toMatchObject({ outcome: "enqueued" });
    expect(replay).toMatchObject({ outcome: "replayed", command: { id: first.command.id } });
    await expect(
      bridge.submit(commandInput({ requestHash: digest("conflicting-request") }))
    ).rejects.toBeInstanceOf(ExecutorCommandIdempotencyConflictError);

    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "applied",
      command: { id: first.command.id, status: "applied" }
    });
    await expect(bridge.submitAndWait(commandInput(), 250)).resolves.toMatchObject({
      outcome: "applied",
      enqueueOutcome: "replayed",
      command: { id: first.command.id, status: "applied" }
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(bridge.readiness().queue).toMatchObject({ submitted: 1, replayed: 2, processed: 1 });
  });

  it("auto-starts submit-and-wait, reconciles startup and returns typed revocation", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const apply = vi.fn(async () => applied("must-not-apply"));
    const authorize: ExecutorAuthorizationValidator = async () => ({
      outcome: "rejected",
      errorCode: "authorization.revoked",
      errorMessage: "The authorization revision is no longer current."
    });
    const bridge = createBridge(repository, { authorize, apply });

    const result = await bridge.submitAndWait(commandInput(), 250);
    expect(result).toMatchObject({
      outcome: "rejected",
      enqueueOutcome: "enqueued",
      command: {
        status: "rejected",
        errorCode: "authorization.revoked"
      }
    });
    expect(repository.recoverCalls).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    expect(bridge.readiness()).toMatchObject({
      ready: true,
      lifecycle: "running",
      applying: null
    });
  });

  it("persists a typed domain rejection without treating it as a retryable crash", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const bridge = createBridge(repository, {
      apply: async () => ({
        outcome: "rejected",
        errorCode: "target.missing",
        errorMessage: "The paper portfolio target no longer exists."
      })
    });
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "rejected",
      command: {
        id: submitted.command.id,
        status: "rejected",
        errorCode: "target.missing"
      }
    });
    expect(repository.rejectedAcknowledgementCalls).toBe(1);
    expect(bridge.readiness().lastError).toBeNull();
  });

  it("reconciles an exact SQLite receipt before revoked authorization after a lost PostgreSQL ACK", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    repository.nextAppliedAcknowledgement = "throw";
    const sqliteReceipts = new Map<string, string>();
    let sqliteWrites = 0;
    let authorized = true;
    const authorize = vi.fn(async () => authorized
      ? { outcome: "authorized" as const }
      : {
          outcome: "rejected" as const,
          errorCode: "authorization.revoked"
        });
    const probeAppliedReceipt = vi.fn(async (identity: { commandId: string }) => {
      const receipt = sqliteReceipts.get(identity.commandId);
      return receipt
        ? { outcome: "applied" as const, sqliteReceiptHash: receipt }
        : { outcome: "not-found" as const };
    });
    const apply = vi.fn(async (command) => {
      let receipt = sqliteReceipts.get(command.id);
      if (!receipt) {
        receipt = digest(`sqlite:${command.id}`);
        sqliteReceipts.set(command.id, receipt);
        sqliteWrites += 1;
      }
      return { outcome: "applied" as const, sqliteReceiptHash: receipt };
    });
    const bridge = createBridge(repository, { authorize, apply, probeAppliedReceipt });
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "retry-scheduled",
      commandId: submitted.command.id
    });
    expect(repository.inspect(submitted.command.id)).toMatchObject({ status: "applying", attempt: 1 });
    expect(probeAppliedReceipt).not.toHaveBeenCalled();
    authorized = false;
    repository.expire(submitted.command.id);

    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "applied",
      command: { status: "applied", attempt: 2 }
    });
    expect(probeAppliedReceipt).toHaveBeenCalledTimes(1);
    expect(probeAppliedReceipt.mock.calls[0]?.[0]).toEqual({
      commandId: submitted.command.id,
      ownerUserId: submitted.command.ownerUserId,
      idempotencyKey: submitted.command.idempotencyKey,
      requestHash: submitted.command.requestHash
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(sqliteWrites).toBe(1);
    expect(repository.appliedAcknowledgementCalls).toBe(2);
    expect(bridge.readiness().lastError).toMatchObject({
      code: "postgres_acknowledgement_failed"
    });
  });

  it("never lets a preauthorization receipt probe bypass authorization for a fresh command", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const probeAppliedReceipt = vi.fn(async () => ({
      outcome: "applied" as const,
      sqliteReceiptHash: digest("forged-fresh-receipt")
    }));
    const authorize = vi.fn(async () => ({
      outcome: "rejected" as const,
      errorCode: "authorization.revoked"
    }));
    const apply = vi.fn(async () => applied("must-not-apply"));
    const bridge = createBridge(repository, { probeAppliedReceipt, authorize, apply });
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "rejected",
      command: { id: submitted.command.id, errorCode: "authorization.revoked" }
    });
    expect(probeAppliedReceipt).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("requires current authorization when a reclaimed command has no exact applied receipt", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    let authorized = true;
    const probeAppliedReceipt = vi.fn(async () => ({ outcome: "not-found" as const }));
    const authorize = vi.fn(async () => authorized
      ? { outcome: "authorized" as const }
      : {
          outcome: "rejected" as const,
          errorCode: "authorization.revoked"
        });
    const apply = vi.fn(async () => {
      throw new Error("executor crashed before a durable SQLite receipt");
    });
    const bridge = createBridge(repository, { probeAppliedReceipt, authorize, apply });
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({ outcome: "retry-scheduled" });
    authorized = false;
    repository.expire(submitted.command.id);
    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "rejected",
      command: { id: submitted.command.id, status: "rejected", errorCode: "authorization.revoked" }
    });
    expect(probeAppliedReceipt).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge through a stale lease fence", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    repository.nextAppliedAcknowledgement = "stale-fence";
    const bridge = createBridge(repository);
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toEqual({
      outcome: "stale-fence",
      commandId: submitted.command.id
    });
    expect(repository.inspect(submitted.command.id)).toMatchObject({ status: "applying" });
    expect(bridge.readiness().lastError).toMatchObject({ code: "stale_lease_fence" });
  });

  it("coalesces concurrent pump calls behind one singleton claim and apply", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    let releaseApply: ((result: ExecutorApplyResult) => void) | undefined;
    const apply = vi.fn(() => new Promise<ExecutorApplyResult>((resolve) => {
      releaseApply = resolve;
    }));
    const bridge = createBridge(repository, { apply });
    const submitted = await bridge.submit(commandInput());

    const firstPump = bridge.pumpOnce();
    await waitFor(() => bridge.readiness().applying?.commandId === submitted.command.id);
    const secondPump = bridge.pumpOnce();
    expect(repository.claimCalls).toBe(1);
    releaseApply?.(applied("receipt-singleton-pump"));
    await expect(Promise.all([firstPump, secondPump])).resolves.toEqual([
      expect.objectContaining({ outcome: "applied" }),
      expect.objectContaining({ outcome: "applied" })
    ]);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("leaves unexpected callback failures for lease expiry and reclaims on the next attempt", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const recoveredFlags: boolean[] = [];
    const apply = vi.fn(async (_command, context) => {
      recoveredFlags.push(context.recovered);
      if (recoveredFlags.length === 1) throw new Error("injected executor crash");
      return applied("receipt-after-crash");
    });
    const bridge = createBridge(repository, { apply });
    const submitted = await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({ outcome: "retry-scheduled" });
    repository.expire(submitted.command.id);
    await expect(bridge.pumpOnce()).resolves.toMatchObject({
      outcome: "applied",
      command: { attempt: 2 }
    });
    expect(recoveredFlags).toEqual([false, true]);
  });

  it("renews the live fence while a long SQLite apply is in progress", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const apply = vi.fn(async () => {
      await delay(125);
      return applied("receipt-long-apply");
    });
    const bridge = createBridge(repository, { apply }, { renewalIntervalMs: 50 });
    await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({ outcome: "applied" });
    expect(repository.renewCalls).toBeGreaterThanOrEqual(2);
  });

  it("requires a valid SQLite receipt before applied acknowledgement", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const apply = vi.fn(async () => ({
      outcome: "applied",
      sqliteReceiptHash: "missing-receipt-digest"
    }) as ExecutorApplyResult);
    const bridge = createBridge(repository, { apply });
    await bridge.submit(commandInput());

    await expect(bridge.pumpOnce()).resolves.toMatchObject({ outcome: "retry-scheduled" });
    expect(repository.appliedAcknowledgementCalls).toBe(0);
    expect(bridge.readiness().lastError).toMatchObject({ code: "executor_callback_failed" });
  });

  it("bounds immediate submit-and-wait when an unexpected apply keeps the lease unresolved", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    const bridge = createBridge(repository, {
      apply: async () => {
        throw new Error("injected non-domain failure");
      }
    });

    const result = await bridge.submitAndWait(commandInput(), 40);
    expect(result).toMatchObject({
      outcome: "timeout",
      enqueueOutcome: "enqueued",
      command: { status: "applying" }
    });
    expect(bridge.readiness().lastError).toMatchObject({ code: "executor_callback_failed" });
  });

  it("bounds pump timing options and exposes retry backoff readiness", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    expect(() => createBridge(repository, {}, { idleIntervalMs: 0 })).toThrow(/idleIntervalMs/);
    const bridge = createBridge(repository, {}, { initialBackoffMs: 100, maxBackoffMs: 100 });
    repository.nextClaimError = new Error("injected queue outage");

    await bridge.start();
    await waitFor(() => bridge.readiness().queue.state === "backoff");
    expect(bridge.readiness()).toMatchObject({
      ready: false,
      queue: { state: "backoff" },
      lastError: { code: "queue_claim_failed", consecutiveFailures: 1 }
    });
    await bridge.submit(commandInput());
    await waitFor(() => bridge.readiness().queue.processed === 1);
    expect(bridge.readiness()).toMatchObject({
      ready: true,
      lifecycle: "running",
      queue: { state: expect.stringMatching(/idle|polling/) }
    });
  });

  it("startup reconciliation terminalizes an exhausted command from the previous process", async () => {
    const repository = new ExecutorCommandRepositoryDouble(1);
    const firstBridge = createBridge(repository, {
      apply: async () => {
        throw new Error("simulated process crash");
      }
    });
    const submitted = await firstBridge.submit(commandInput());
    await firstBridge.pumpOnce();
    repository.expire(submitted.command.id);
    await firstBridge.close();

    const restarted = createBridge(repository);
    await expect(restarted.start()).resolves.toEqual({
      recoveredExpired: 1,
      alreadyRunning: false
    });
    expect(repository.inspect(submitted.command.id)).toMatchObject({
      status: "rejected",
      errorCode: "executor_attempts_exhausted"
    });
  });

  it("quiesces submissions and drains an in-flight command before close", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    let releaseApply: ((result: ExecutorApplyResult) => void) | undefined;
    const apply = vi.fn(() => new Promise<ExecutorApplyResult>((resolve) => {
      releaseApply = resolve;
    }));
    const bridge = createBridge(repository, { apply }, { closeDrainTimeoutMs: 250 });
    await bridge.start();
    const submitted = await bridge.submit(commandInput());
    await waitFor(() => bridge.readiness().applying?.commandId === submitted.command.id);

    const closing = bridge.close({ drainTimeoutMs: 250 });
    await expect(bridge.submit(commandInput({ idempotencyKey: "closed:2" }))).rejects.toBeInstanceOf(
      ExecutorBridgeClosedError
    );
    releaseApply?.(applied("receipt-graceful-close"));
    await expect(closing).resolves.toMatchObject({
      drained: true,
      timedOut: false,
      applyingCommandId: submitted.command.id
    });
    expect(repository.inspect(submitted.command.id)).toMatchObject({ status: "applied" });
    expect(bridge.readiness()).toMatchObject({
      ready: false,
      lifecycle: "closed",
      acceptingSubmissions: false,
      applying: null
    });
  });

  it("aborts a callback at the close deadline and waits for it to settle before returning", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    let callbackSignal: AbortSignal | undefined;
    const apply = vi.fn((_command, context) => {
      callbackSignal = context.signal;
      return new Promise<ExecutorApplyResult>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("close aborted apply")), {
          once: true
        });
      });
    });
    const bridge = createBridge(repository, { apply }, { closeDrainTimeoutMs: 25 });
    await bridge.start();
    const submitted = await bridge.submit(commandInput());
    await waitFor(() => bridge.readiness().applying?.commandId === submitted.command.id);

    await expect(bridge.close({ drainTimeoutMs: 25 })).resolves.toMatchObject({
      drained: true,
      timedOut: true,
      applyingCommandId: submitted.command.id
    });
    expect(callbackSignal?.aborted).toBe(true);
    expect(bridge.readiness()).toMatchObject({ lifecycle: "closed", applying: null });
    expect(repository.inspect(submitted.command.id)).toMatchObject({ status: "applying" });
    expect(repository.appliedAcknowledgementCalls).toBe(0);
  });

  it("refuses to report closed while an apply callback ignores abort", async () => {
    const repository = new ExecutorCommandRepositoryDouble();
    let releaseApply: ((result: ExecutorApplyResult) => void) | undefined;
    const apply = vi.fn(() => new Promise<ExecutorApplyResult>((resolve) => {
      releaseApply = resolve;
    }));
    const bridge = createBridge(repository, { apply }, { closeDrainTimeoutMs: 25 });
    await bridge.start();
    const submitted = await bridge.submit(commandInput());
    await waitFor(() => bridge.readiness().applying?.commandId === submitted.command.id);

    await expect(bridge.close({ drainTimeoutMs: 25 })).resolves.toEqual({
      drained: false,
      timedOut: true,
      applyingCommandId: submitted.command.id
    });
    expect(bridge.readiness()).toMatchObject({
      ready: false,
      lifecycle: "quiescing",
      acceptingSubmissions: false,
      applying: { commandId: submitted.command.id }
    });

    releaseApply?.(applied("ignored-abort-released"));
    await waitFor(() => bridge.readiness().applying === null);
    await expect(bridge.close({ drainTimeoutMs: 25 })).resolves.toMatchObject({
      drained: true,
      applyingCommandId: null
    });
    expect(bridge.readiness().lifecycle).toBe("closed");
  });
});

function createBridge(
  repository: ExecutorCommandRepositoryDouble,
  overrides: Partial<Pick<ExecutorBridgeDependencies, "probeAppliedReceipt" | "authorize" | "apply">> = {},
  optionOverrides: Partial<ExecutorBridgeOptions> = {}
): FencedExecutorBridge {
  const bridge = new FencedExecutorBridge(
    {
      repository,
      probeAppliedReceipt: overrides.probeAppliedReceipt ?? (async () => ({ outcome: "not-found" })),
      authorize: overrides.authorize ?? (async () => ({ outcome: "authorized" })),
      apply: overrides.apply ?? (async () => applied("receipt-default"))
    },
    {
      workerId: "executor-bridge-test",
      leaseMs: 1_000,
      renewalIntervalMs: 100,
      idleIntervalMs: 5,
      busyIntervalMs: 1,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      submitWaitPollMs: 5,
      submitWaitTimeoutMs: 250,
      closeDrainTimeoutMs: 100,
      ...optionOverrides
    }
  );
  bridges.push(bridge);
  return bridge;
}

function commandInput(
  overrides: Partial<EnqueueExecutorCommandInput> = {}
): EnqueueExecutorCommandInput {
  return {
    ownerUserId: "00000000-0000-4000-8000-000000000081",
    actorUserId: "00000000-0000-4000-8000-000000000082",
    sessionIdHash: digest("bridge-session"),
    authorizationRevision: 7,
    authorizationEpoch: 8,
    commandType: "paper.bot.start",
    targetType: "bot",
    targetId: "paper-bot:bridge",
    idempotencyKey: "bridge-command:1",
    requestHash: digest("bridge-command:1"),
    payload: { requestedState: "running" },
    ...overrides
  };
}

function applied(value: string): Extract<ExecutorApplyResult, { outcome: "applied" }> {
  return { outcome: "applied", sqliteReceiptHash: digest(value) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for executor bridge state");
    await delay(5);
  }
}
