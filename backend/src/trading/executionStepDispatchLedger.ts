import { createHash } from "node:crypto";
import { ExecutionStepLedgerCapacityError, ExecutionStepLedgerDurableCapacityError, type ExecutionStepLedgerRepository, type ExecutionStepOperationKind } from "../database/executionStepLedgerTypes.js";
import { canonicalExecutionValue } from "./executionCapabilities.js";
import { ExecutionPermitError, executionPermitBindingDigest, executionPermitExpectation, type ExecutionPermitClaims, type ExecutionPermitOperation, type IssuedExecutionPermit } from "./executionPermits.js";

export interface DurableExecutionStepReservation {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly reservationId: string;
  readonly bindingDigest: string;
}

/**
 * Bridges a process-local permit to the PostgreSQL replay ledger. This gives
 * mutation dispatch durable at-most-once semantics across retries/restarts;
 * exchange-side exactly-once still requires a stable venue client ID and
 * reconciliation of unknown outcomes.
 */
export class ExecutionStepDispatchLedger {
  constructor(private readonly repository: ExecutionStepLedgerRepository) {}

  async reserve(issued: IssuedExecutionPermit): Promise<DurableExecutionStepReservation> {
    const claims = issued.claims;
    if (!requiresDurableExecutionStep(claims)) {
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Private reads must not allocate durable mutation replay keys.");
    }
    const bindingDigest = executionPermitBindingDigest(executionPermitExpectation(claims));
    try {
      const result = await this.repository.reserve({
        ownerUserId: claims.ownerUserId,
        accountId: claims.accountId,
        operationKind: ledgerOperationKind(claims.operation),
        operationId: operationGroupDigest(claims.operation),
        intentId: claims.intentId,
        intentDigest: claims.intentDigest,
        signedRequestDigest: claims.signedRequestDigest,
        bindingDigest,
        accountRevision: claims.accountRevision,
        credentialRevision: claims.credentialRevision,
        authorizationRevision: claims.authorizationRevision,
        authorizationEpoch: claims.authorizationEpoch,
        liveArmEpoch: claims.liveArmEpoch,
        reservationTtlMs: Math.max(1_000, claims.expiresAt - claims.issuedAt)
      });
      if (result.outcome === "duplicate") {
        throw new ExecutionPermitError("PERMIT_DUPLICATE_STEP", "This exact execution step already has a durable replay key.");
      }
      if (result.outcome === "conflict") {
        throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Execution intent identity is already bound to a different signed step.");
      }
      return Object.freeze({
        ownerUserId: result.record.ownerUserId,
        intentId: result.record.intentId,
        reservationId: result.record.reservationId,
        bindingDigest: result.record.bindingDigest
      });
    } catch (error) {
      if (error instanceof ExecutionPermitError) throw error;
      if (error instanceof ExecutionStepLedgerCapacityError || error instanceof ExecutionStepLedgerDurableCapacityError) {
        throw new ExecutionPermitError("PERMIT_CAPACITY", "Durable execution-step capacity is exhausted.");
      }
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Durable execution replay protection is unavailable.");
    }
  }

  async consume(reservation: DurableExecutionStepReservation): Promise<void> {
    let result: Awaited<ReturnType<ExecutionStepLedgerRepository["consume"]>>;
    try {
      result = await this.repository.consume(reservation);
    } catch {
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Durable execution replay protection is unavailable.");
    }
    switch (result.outcome) {
      case "consumed":
        return;
      case "duplicate":
      case "tombstone":
        throw new ExecutionPermitError("PERMIT_REUSED", "Execution step was already durably consumed.");
      case "expired":
        throw new ExecutionPermitError("PERMIT_EXPIRED", "Durable execution-step reservation expired.");
      case "conflict":
        throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Durable execution-step reservation does not match this handoff.");
      case "missing":
        throw new ExecutionPermitError("PERMIT_REVOKED", "Durable execution-step reservation is unavailable.");
    }
  }
}

export function requiresDurableExecutionStep(claims: Pick<ExecutionPermitClaims, "capability">): boolean {
  return claims.capability !== "private-read" && claims.capability !== "public-read";
}

function ledgerOperationKind(operation: ExecutionPermitOperation): ExecutionStepOperationKind {
  if (operation.kind === "telemetry") {
    throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Telemetry operations cannot dispatch private mutations.");
  }
  return operation.kind;
}

function operationGroupDigest(operation: ExecutionPermitOperation): string {
  return createHash("sha256").update("saltanatbotv2:execution-operation-group:v1\0").update(canonicalExecutionValue(operation)).digest("hex");
}
