import {
  DEFAULT_EXECUTOR_COMMAND_MAX_ATTEMPTS,
  DEFAULT_EXECUTOR_COMMAND_MAX_ACTIVE_PER_OWNER,
  DEFAULT_EXECUTOR_COMMAND_MAX_TERMINAL_PER_OWNER,
  DEFAULT_EXECUTOR_COMMAND_PRUNE_BATCH_SIZE,
  DEFAULT_EXECUTOR_COMMAND_TERMINAL_RETENTION_MS,
  MAX_EXECUTOR_COMMAND_ATTEMPTS,
  MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS,
  MAX_EXECUTOR_COMMAND_LEASE_MS,
  MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES,
  MAX_EXECUTOR_COMMAND_RESULT_BYTES,
  type AcknowledgeAppliedExecutorCommandInput,
  type AcknowledgeRejectedExecutorCommandInput,
  type EnqueueExecutorCommandInput,
  type ExecutorCommandLeaseFence,
  type ExecutorCommandRepositoryOptions
} from "./executorCommandTypes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/;
const FORBIDDEN_JSON_KEY = /(password|passphrase|secret|api.?key|private.?key|access.?token|refresh.?token|bearer.?token|session.?token|signature)/i;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 8_192;

export interface ValidatedEnqueueExecutorCommandInput {
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
  readonly payloadJson: string;
}

export interface ValidatedExecutorCommandOptions {
  readonly maxActivePerOwner: number;
  readonly maxAttempts: number;
  readonly terminalRetentionMs: number;
  readonly maxTerminalPerOwner: number;
  readonly pruneBatchSize: number;
}

export function validateEnqueueExecutorCommandInput(
  input: EnqueueExecutorCommandInput
): ValidatedEnqueueExecutorCommandInput {
  const payloadJson = serializeBoundedJsonObject(
    input.payload,
    "payload",
    MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES
  );
  return {
    ownerUserId: requireExecutorCommandUuid(input.ownerUserId, "ownerUserId"),
    actorUserId:
      input.actorUserId === null || input.actorUserId === undefined
        ? null
        : requireExecutorCommandUuid(input.actorUserId, "actorUserId"),
    sessionIdHash: requireExecutorCommandDigest(input.sessionIdHash, "sessionIdHash"),
    authorizationRevision: positiveSafeInteger(
      input.authorizationRevision,
      "authorizationRevision"
    ),
    authorizationEpoch: nonNegativeSafeInteger(input.authorizationEpoch, "authorizationEpoch"),
    commandType: requireType(input.commandType, "commandType"),
    targetType: requireType(input.targetType, "targetType"),
    targetId: requireOpaqueId(input.targetId, "targetId", 160),
    idempotencyKey: requireOpaqueId(input.idempotencyKey, "idempotencyKey", 160),
    requestHash: requireExecutorCommandDigest(input.requestHash, "requestHash"),
    payload: JSON.parse(payloadJson) as Record<string, unknown>,
    payloadJson
  };
}

export function validateExecutorCommandLeaseFence(
  input: ExecutorCommandLeaseFence
): ExecutorCommandLeaseFence {
  return {
    commandId: requireExecutorCommandUuid(input.commandId, "commandId"),
    leaseToken: requireExecutorCommandUuid(input.leaseToken, "leaseToken"),
    leaseGeneration: positiveSafeInteger(input.leaseGeneration, "leaseGeneration")
  };
}

export function validateAppliedExecutorCommandAcknowledgement(
  input: AcknowledgeAppliedExecutorCommandInput
): ExecutorCommandLeaseFence & { sqliteReceiptHash: string; resultJson: string | null } {
  return {
    ...validateExecutorCommandLeaseFence(input),
    sqliteReceiptHash: requireExecutorCommandDigest(
      input.sqliteReceiptHash,
      "sqliteReceiptHash"
    ),
    resultJson:
      input.result === undefined
        ? null
        : serializeBoundedJsonObject(
            input.result,
            "result",
            MAX_EXECUTOR_COMMAND_RESULT_BYTES
          )
  };
}

export function validateRejectedExecutorCommandAcknowledgement(
  input: AcknowledgeRejectedExecutorCommandInput
): ExecutorCommandLeaseFence & { errorCode: string; errorMessage: string | null } {
  if (typeof input.errorCode !== "string" || !ERROR_CODE_PATTERN.test(input.errorCode)) {
    throw new TypeError("errorCode is invalid");
  }
  const errorMessage = input.errorMessage ?? null;
  if (
    errorMessage !== null
    && (
      typeof errorMessage !== "string"
      || errorMessage.length < 1
      || errorMessage.length > MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS
    )
  ) {
    throw new TypeError(
      `errorMessage must contain between 1 and ${MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS} characters`
    );
  }
  return {
    ...validateExecutorCommandLeaseFence(input),
    errorCode: input.errorCode,
    errorMessage
  };
}

export function validateExecutorCommandRepositoryOptions(
  options: ExecutorCommandRepositoryOptions
): ValidatedExecutorCommandOptions {
  return {
    maxActivePerOwner: boundedSafeInteger(
      options.maxActivePerOwner ?? DEFAULT_EXECUTOR_COMMAND_MAX_ACTIVE_PER_OWNER,
      "maxActivePerOwner",
      1,
      10_000
    ),
    maxAttempts: boundedSafeInteger(
      options.maxAttempts ?? DEFAULT_EXECUTOR_COMMAND_MAX_ATTEMPTS,
      "maxAttempts",
      1,
      MAX_EXECUTOR_COMMAND_ATTEMPTS
    ),
    terminalRetentionMs: boundedSafeInteger(
      options.terminalRetentionMs ?? DEFAULT_EXECUTOR_COMMAND_TERMINAL_RETENTION_MS,
      "terminalRetentionMs",
      1_000,
      365 * 24 * 60 * 60 * 1_000
    ),
    maxTerminalPerOwner: boundedSafeInteger(
      options.maxTerminalPerOwner ?? DEFAULT_EXECUTOR_COMMAND_MAX_TERMINAL_PER_OWNER,
      "maxTerminalPerOwner",
      1,
      1_000_000
    ),
    pruneBatchSize: boundedSafeInteger(
      options.pruneBatchSize ?? DEFAULT_EXECUTOR_COMMAND_PRUNE_BATCH_SIZE,
      "pruneBatchSize",
      1,
      10_000
    )
  };
}

export function validateExecutorCommandLease(
  workerId: string,
  leaseMs: number
): { workerId: string; leaseMs: number } {
  return {
    workerId: requireOpaqueId(workerId, "workerId", 128),
    leaseMs: boundedSafeInteger(leaseMs, "leaseMs", 1_000, MAX_EXECUTOR_COMMAND_LEASE_MS)
  };
}

export function validateExecutorCommandListLimit(limit: number): number {
  return boundedSafeInteger(limit, "limit", 1, 100);
}

export function requireExecutorCommandUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function requireExecutorCommandDigest(value: string, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function executorCommandSafeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return parsed;
}

function requireType(value: string, label: string): string {
  if (typeof value !== "string" || !TYPE_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireOpaqueId(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || hasControlCharacters(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function serializeBoundedJsonObject(
  value: Record<string, unknown>,
  label: string,
  maximumBytes: number
): string {
  const state = { nodes: 0 };
  validateJsonValue(value, label, 0, state, true);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be a JSON object`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new TypeError(`${label} exceeds ${maximumBytes} bytes`);
  }
  return serialized;
}

function validateJsonValue(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number },
  root = false
): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${label} is too complex`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (root) throw new TypeError(`${label} must be a JSON object`);
    for (const item of value) validateJsonValue(item, label, depth + 1, state);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must contain only JSON values`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain JSON objects`);
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_JSON_KEY.test(key)) {
      throw new TypeError(`${label} must not contain secret-bearing fields`);
    }
    validateJsonValue(item, label, depth + 1, state);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
