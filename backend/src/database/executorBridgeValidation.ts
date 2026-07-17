import type {
  ExecutorAppliedReceiptProbeResult,
  ExecutorApplyResult,
  ExecutorAuthorizationDecision,
  ExecutorBridgeOptions
} from "./executorBridgeTypes.js";
import { boundedBridgeInteger } from "./executorBridgeTiming.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/;

export interface ResolvedExecutorBridgeOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly busyIntervalMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly submitWaitPollMs: number;
  readonly submitWaitTimeoutMs: number;
  readonly closeDrainTimeoutMs: number;
}

export function resolveExecutorBridgeOptions(
  options: ExecutorBridgeOptions
): ResolvedExecutorBridgeOptions {
  const workerId = requireWorkerId(options.workerId);
  const leaseMs = boundedBridgeInteger(options.leaseMs ?? 30_000, "leaseMs", 1_000, 300_000);
  const renewalIntervalMs = boundedBridgeInteger(
    options.renewalIntervalMs ?? Math.max(50, Math.floor(leaseMs / 3)),
    "renewalIntervalMs",
    50,
    Math.floor(leaseMs / 2)
  );
  const initialBackoffMs = boundedBridgeInteger(
    options.initialBackoffMs ?? 250,
    "initialBackoffMs",
    5,
    60_000
  );
  const maxBackoffMs = boundedBridgeInteger(
    options.maxBackoffMs ?? 5_000,
    "maxBackoffMs",
    initialBackoffMs,
    60_000
  );
  return {
    workerId,
    leaseMs,
    renewalIntervalMs,
    idleIntervalMs: boundedBridgeInteger(
      options.idleIntervalMs ?? 250,
      "idleIntervalMs",
      5,
      60_000
    ),
    busyIntervalMs: boundedBridgeInteger(
      options.busyIntervalMs ?? 10,
      "busyIntervalMs",
      1,
      10_000
    ),
    initialBackoffMs,
    maxBackoffMs,
    submitWaitPollMs: boundedBridgeInteger(
      options.submitWaitPollMs ?? 25,
      "submitWaitPollMs",
      5,
      5_000
    ),
    submitWaitTimeoutMs: boundedBridgeInteger(
      options.submitWaitTimeoutMs ?? 10_000,
      "submitWaitTimeoutMs",
      25,
      300_000
    ),
    closeDrainTimeoutMs: boundedBridgeInteger(
      options.closeDrainTimeoutMs ?? 10_000,
      "closeDrainTimeoutMs",
      25,
      300_000
    )
  };
}

export function validateExecutorBridgeWaitTimeout(timeoutMs: number): number {
  return boundedBridgeInteger(timeoutMs, "timeoutMs", 25, 300_000);
}

export function validateAuthorizationDecision(
  value: ExecutorAuthorizationDecision
): ExecutorAuthorizationDecision {
  if (value?.outcome === "authorized") return value;
  if (value?.outcome === "rejected") {
    validateDomainRejection(value.errorCode, value.errorMessage);
    return value;
  }
  throw new TypeError("Authorization validator returned an invalid decision");
}

export function validateExecutorApplyResult(value: ExecutorApplyResult): ExecutorApplyResult {
  if (value?.outcome === "applied") {
    if (!DIGEST_PATTERN.test(value.sqliteReceiptHash)) {
      throw new TypeError("Applied executor result requires a lowercase SQLite receipt SHA-256");
    }
    if (
      value.result !== undefined
      && (
        !value.result
        || typeof value.result !== "object"
        || Array.isArray(value.result)
      )
    ) {
      throw new TypeError("Applied executor result payload must be a JSON object");
    }
    return value;
  }
  if (value?.outcome === "rejected") {
    validateDomainRejection(value.errorCode, value.errorMessage);
    return value;
  }
  throw new TypeError("Executor apply callback returned an invalid result");
}

export function validateAppliedReceiptProbeResult(
  value: ExecutorAppliedReceiptProbeResult
): ExecutorAppliedReceiptProbeResult {
  if (value?.outcome === "not-found") return value;
  if (value?.outcome === "applied") {
    if (!DIGEST_PATTERN.test(value.sqliteReceiptHash)) {
      throw new TypeError("Applied receipt probe requires a lowercase SQLite receipt SHA-256");
    }
    return value;
  }
  throw new TypeError("Applied receipt probe returned an invalid decision");
}

function validateDomainRejection(errorCode: string, errorMessage?: string): void {
  if (typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)) {
    throw new TypeError("Domain rejection errorCode is invalid");
  }
  if (
    errorMessage !== undefined
    && (
      typeof errorMessage !== "string"
      || errorMessage.length < 1
      || errorMessage.length > 4_000
    )
  ) {
    throw new TypeError("Domain rejection errorMessage is invalid");
  }
}

function requireWorkerId(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || value.trim() !== value
    || hasControlCharacters(value)
  ) {
    throw new TypeError("workerId is invalid");
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
