import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS,
  MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES,
  MAX_EXECUTOR_COMMAND_RESULT_BYTES,
  type EnqueueExecutorCommandInput
} from "../src/database/executorCommandTypes.js";
import {
  validateAppliedExecutorCommandAcknowledgement,
  validateEnqueueExecutorCommandInput,
  validateExecutorCommandLease,
  validateExecutorCommandListLimit,
  validateExecutorCommandRepositoryOptions,
  validateRejectedExecutorCommandAcknowledgement
} from "../src/database/executorCommandValidation.js";

describe("executor command boundary validation", () => {
  it("accepts a bounded secret-free command and normalizes UUIDs", () => {
    const ownerUserId = randomUUID().toUpperCase();
    const actorUserId = randomUUID().toUpperCase();
    const validated = validateEnqueueExecutorCommandInput(
      commandInput({
        ownerUserId,
        actorUserId,
        payload: { enabled: true, legs: [{ venue: "paper", quantity: 2 }] }
      })
    );

    expect(validated).toMatchObject({
      ownerUserId: ownerUserId.toLowerCase(),
      actorUserId: actorUserId.toLowerCase(),
      authorizationRevision: 2,
      authorizationEpoch: 3,
      commandType: "paper.bot.start",
      targetType: "bot",
      targetId: "paper-bot:1"
    });
    expect(JSON.parse(validated.payloadJson)).toEqual(validated.payload);
  });

  it("requires valid authorization fences, bounded identifiers and lowercase digests", () => {
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ authorizationRevision: 0 }))
    ).toThrow(/positive/);
    expect(
      validateEnqueueExecutorCommandInput(commandInput({ authorizationEpoch: 0 }))
        .authorizationEpoch
    ).toBe(0);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ authorizationEpoch: -1 }))
    ).toThrow(/non-negative/);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ commandType: "Paper.Start" }))
    ).toThrow(/commandType/);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ targetId: ` ${"x".repeat(160)}` }))
    ).toThrow(/targetId/);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ requestHash: digest("request").toUpperCase() }))
    ).toThrow(/lowercase SHA-256/);
  });

  it("rejects secret-bearing, non-JSON, cyclic and oversized payloads", () => {
    const forbiddenPayload = Object.fromEntries([["api" + "Key", "redacted"]]);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ payload: forbiddenPayload }))
    ).toThrow(/secret-bearing/);
    expect(() =>
      validateEnqueueExecutorCommandInput(
        commandInput({ payload: { timestamp: new Date() } as unknown as Record<string, unknown> })
      )
    ).toThrow(/plain JSON objects/);
    expect(() =>
      validateEnqueueExecutorCommandInput(commandInput({ payload: { ratio: Number.NaN } }))
    ).toThrow(/non-finite/);
    expect(() =>
      validateEnqueueExecutorCommandInput(
        commandInput({ payload: [] as unknown as Record<string, unknown> })
      )
    ).toThrow(/JSON object/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEnqueueExecutorCommandInput(commandInput({ payload: cyclic }))).toThrow();
    expect(() =>
      validateEnqueueExecutorCommandInput(
        commandInput({ payload: { value: "x".repeat(MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES) } })
      )
    ).toThrow(/exceeds/);
  });

  it("validates fenced applied and rejected acknowledgements", () => {
    const fence = {
      commandId: randomUUID(),
      leaseToken: randomUUID(),
      leaseGeneration: 4
    };
    expect(
      validateAppliedExecutorCommandAcknowledgement({
        ...fence,
        sqliteReceiptHash: digest("receipt"),
        result: { applied: true }
      })
    ).toMatchObject({ ...fence, sqliteReceiptHash: digest("receipt") });
    expect(() =>
      validateAppliedExecutorCommandAcknowledgement({
        ...fence,
        sqliteReceiptHash: digest("receipt"),
        result: { value: "x".repeat(MAX_EXECUTOR_COMMAND_RESULT_BYTES) }
      })
    ).toThrow(/exceeds/);
    expect(() =>
      validateAppliedExecutorCommandAcknowledgement({
        ...fence,
        sqliteReceiptHash: "not-a-digest"
      })
    ).toThrow(/SHA-256/);

    expect(
      validateRejectedExecutorCommandAcknowledgement({
        ...fence,
        errorCode: "authorization.revoked",
        errorMessage: "The authorization fence changed."
      })
    ).toMatchObject({ errorCode: "authorization.revoked" });
    expect(() =>
      validateRejectedExecutorCommandAcknowledgement({
        ...fence,
        errorCode: "Invalid Code"
      })
    ).toThrow(/errorCode/);
    expect(() =>
      validateRejectedExecutorCommandAcknowledgement({
        ...fence,
        errorCode: "invalid",
        errorMessage: "x".repeat(MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS + 1)
      })
    ).toThrow(/errorMessage/);
  });

  it("keeps worker leases and repository limits within hard bounds", () => {
    expect(validateExecutorCommandLease("executor-1", 1_000)).toEqual({
      workerId: "executor-1",
      leaseMs: 1_000
    });
    expect(() => validateExecutorCommandLease("executor-1", 999)).toThrow(/leaseMs/);
    expect(() => validateExecutorCommandLease(" executor-1", 1_000)).toThrow(/workerId/);
    expect(validateExecutorCommandListLimit(100)).toBe(100);
    expect(() => validateExecutorCommandListLimit(Number.NaN)).toThrow(/limit/);
    expect(() => validateExecutorCommandListLimit(101)).toThrow(/limit/);
    expect(() => validateExecutorCommandRepositoryOptions({ maxAttempts: 33 })).toThrow(
      /maxAttempts/
    );
    expect(() =>
      validateExecutorCommandRepositoryOptions({ terminalRetentionMs: 999 })
    ).toThrow(/terminalRetentionMs/);
  });
});

function commandInput(
  overrides: Partial<EnqueueExecutorCommandInput> = {}
): EnqueueExecutorCommandInput {
  return {
    ownerUserId: "00000000-0000-4000-8000-000000000061",
    actorUserId: "00000000-0000-4000-8000-000000000062",
    sessionIdHash: digest("session"),
    authorizationRevision: 2,
    authorizationEpoch: 3,
    commandType: "paper.bot.start",
    targetType: "bot",
    targetId: "paper-bot:1",
    idempotencyKey: "executor-command-request:1",
    requestHash: digest("request"),
    payload: { requestedState: "running" },
    ...overrides
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
