import { randomUUID } from "node:crypto";
import type { ConsumeExecutionStepInput, ConsumeExecutionStepResult, ExecutionStepLedgerPruneResult, ExecutionStepLedgerRecord, ExecutionStepLedgerRepository, ExecutionStepLedgerRetentionOptions, ReserveExecutionStepInput, ReserveExecutionStepResult } from "../../src/database/executionStepLedgerTypes.js";

export class TestExecutionStepLedger implements ExecutionStepLedgerRepository {
  private readonly records = new Map<string, ExecutionStepLedgerRecord>();
  private readonly bindings = new Map<string, ExecutionStepLedgerRecord>();

  async reserve(input: ReserveExecutionStepInput): Promise<ReserveExecutionStepResult> {
    const key = stepKey(input.ownerUserId, input.intentId);
    const existingIntent = this.records.get(key);
    const existingBinding = this.bindings.get(stepKey(input.ownerUserId, input.bindingDigest));
    if (existingIntent || existingBinding) {
      if (existingIntent && existingIntent === existingBinding && exactStep(existingIntent, input)) {
        return { outcome: "duplicate", key: existingIntent, record: existingIntent };
      }
      return {
        outcome: "conflict",
        conflictOn: existingIntent && existingBinding ? "intent-and-binding" : existingIntent ? "intent" : "binding"
      };
    }
    const reservedAt = new Date();
    const record: ExecutionStepLedgerRecord = Object.freeze({
      ...input,
      reservationTtlMs: undefined,
      status: "reserved",
      reservationId: randomUUID(),
      reservedAt,
      reservationExpiresAt: new Date(reservedAt.getTime() + (input.reservationTtlMs ?? 60_000)),
      consumedAt: null,
      terminalAt: null,
      reservationCreatedAt: reservedAt,
      createdAt: reservedAt,
      updatedAt: reservedAt
    });
    this.records.set(key, record);
    this.bindings.set(stepKey(input.ownerUserId, input.bindingDigest), record);
    return { outcome: "reserved", record };
  }

  async consume(input: ConsumeExecutionStepInput): Promise<ConsumeExecutionStepResult> {
    const key = stepKey(input.ownerUserId, input.intentId);
    const current = this.records.get(key);
    if (!current) return { outcome: "missing" };
    if (current.reservationId !== input.reservationId || current.bindingDigest !== input.bindingDigest) {
      return { outcome: "conflict" };
    }
    if (current.status === "consumed") return { outcome: "duplicate", status: "consumed" };
    if (current.status === "expired" || current.reservationExpiresAt.getTime() <= Date.now()) {
      return { outcome: "expired" };
    }
    const consumedAt = new Date();
    const consumed = Object.freeze({
      ...current,
      status: "consumed" as const,
      consumedAt,
      terminalAt: consumedAt,
      updatedAt: consumedAt
    });
    this.records.set(key, consumed);
    this.bindings.set(stepKey(input.ownerUserId, input.bindingDigest), consumed);
    return { outcome: "consumed", record: consumed };
  }

  async pruneOwner(_ownerUserId: string, _options?: ExecutionStepLedgerRetentionOptions): Promise<ExecutionStepLedgerPruneResult> {
    return { expired: 0, deletedByAge: 0, deletedByCount: 0 };
  }
}

function exactStep(record: ExecutionStepLedgerRecord, input: ReserveExecutionStepInput): boolean {
  return (
    record.ownerUserId === input.ownerUserId &&
    record.accountId === input.accountId &&
    record.operationKind === input.operationKind &&
    record.operationId === input.operationId &&
    record.intentId === input.intentId &&
    record.intentDigest === input.intentDigest &&
    record.signedRequestDigest === input.signedRequestDigest &&
    record.bindingDigest === input.bindingDigest &&
    record.accountRevision === input.accountRevision &&
    record.credentialRevision === input.credentialRevision &&
    record.authorizationRevision === input.authorizationRevision &&
    record.authorizationEpoch === input.authorizationEpoch &&
    record.liveArmEpoch === input.liveArmEpoch
  );
}

function stepKey(ownerUserId: string, value: string): string {
  return `${ownerUserId}\0${value}`;
}
