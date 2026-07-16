import {
  DEFAULT_EXECUTION_STEP_MAX_TERMINAL_ROWS_PER_OWNER,
  DEFAULT_EXECUTION_STEP_PRUNE_BATCH_SIZE,
  DEFAULT_EXECUTION_STEP_TERMINAL_RETENTION_MS,
  EXECUTION_STEP_OPERATION_KINDS,
  type ExecutionStepLedgerRetentionOptions,
  type ReserveExecutionStepInput
} from "./executionStepLedgerTypes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function validateReserveInput(
  input: ReserveExecutionStepInput,
  defaultReservationTtlMs: number,
  maxReservationTtlMs: number
): Required<ReserveExecutionStepInput> {
  if (!EXECUTION_STEP_OPERATION_KINDS.includes(input.operationKind)) {
    throw new TypeError("operationKind is invalid");
  }
  return {
    ownerUserId: requireUuid(input.ownerUserId, "ownerUserId"),
    accountId: requireBoundedId(input.accountId, "accountId"),
    operationKind: input.operationKind,
    operationId: requireBoundedId(input.operationId, "operationId"),
    intentId: requireBoundedId(input.intentId, "intentId"),
    intentDigest: requireDigest(input.intentDigest, "intentDigest"),
    signedRequestDigest: requireDigest(input.signedRequestDigest, "signedRequestDigest"),
    bindingDigest: requireDigest(input.bindingDigest, "bindingDigest"),
    accountRevision: positiveSafeInteger(input.accountRevision, "accountRevision"),
    credentialRevision: positiveSafeInteger(input.credentialRevision, "credentialRevision"),
    authorizationRevision: positiveSafeInteger(input.authorizationRevision, "authorizationRevision"),
    authorizationEpoch: nonNegativeSafeInteger(input.authorizationEpoch, "authorizationEpoch"),
    liveArmEpoch: positiveSafeInteger(input.liveArmEpoch, "liveArmEpoch"),
    reservationTtlMs: boundedInteger(
      input.reservationTtlMs ?? defaultReservationTtlMs,
      "reservationTtlMs",
      1_000,
      maxReservationTtlMs
    )
  };
}

export function retentionOptions(
  options: ExecutionStepLedgerRetentionOptions
): Required<ExecutionStepLedgerRetentionOptions> {
  return {
    terminalRetentionMs: boundedInteger(
      options.terminalRetentionMs ?? DEFAULT_EXECUTION_STEP_TERMINAL_RETENTION_MS,
      "terminalRetentionMs",
      1_000,
      365 * 24 * 60 * 60 * 1_000
    ),
    maxTerminalRowsPerOwner: boundedInteger(
      options.maxTerminalRowsPerOwner ?? DEFAULT_EXECUTION_STEP_MAX_TERMINAL_ROWS_PER_OWNER,
      "maxTerminalRowsPerOwner",
      1,
      1_000_000
    ),
    batchSize: boundedInteger(
      options.batchSize ?? DEFAULT_EXECUTION_STEP_PRUNE_BATCH_SIZE,
      "batchSize",
      1,
      10_000
    )
  };
}

export function requireUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function requireBoundedId(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 160
    || value.trim() !== value
    || hasControlCharacters(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function requireDigest(value: string, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`PostgreSQL returned an invalid ${label}`);
  return parsed;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
