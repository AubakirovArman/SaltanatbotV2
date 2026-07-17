import {
  parseAlertRuleDocumentV1,
  type AlertRuleDocumentV1,
} from "@saltanatbotv2/contracts";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface CreateAlertRuleRequest {
  clientId: string;
  definition: AlertRuleDocumentV1;
}

export interface UpdateAlertRuleRequest {
  expectedRevision: number;
  definition: AlertRuleDocumentV1;
}

export interface AlertRuleRevisionRequest {
  expectedRevision: number;
}

export function parseCreateAlertRuleRequest(value: unknown): CreateAlertRuleRequest {
  const input = exactObject(value, ["clientId", "definition"], "create alert rule");
  return {
    clientId: identifier(input.clientId, CLIENT_ID, "create alert rule.clientId"),
    definition: parseAlertRuleDocumentV1(input.definition),
  };
}

export function parseUpdateAlertRuleRequest(value: unknown): UpdateAlertRuleRequest {
  const input = exactObject(
    value,
    ["expectedRevision", "definition"],
    "update alert rule",
  );
  return {
    expectedRevision: positiveRevision(
      input.expectedRevision,
      "update alert rule.expectedRevision",
    ),
    definition: parseAlertRuleDocumentV1(input.definition),
  };
}

export function parseAlertRuleRevisionRequest(
  value: unknown,
): AlertRuleRevisionRequest {
  const input = exactObject(
    value,
    ["expectedRevision"],
    "alert rule revision",
  );
  return {
    expectedRevision: positiveRevision(
      input.expectedRevision,
      "alert rule revision.expectedRevision",
    ),
  };
}

export function parseAlertIdempotencyKey(value: unknown): string {
  if (Array.isArray(value)) {
    throw new Error("Idempotency-Key must contain exactly one value");
  }
  return identifier(value, IDEMPOTENCY_KEY, "Idempotency-Key");
}

export function parseAlertPageLimit(
  value: unknown,
  fallback = 100,
  maximum = 500,
): number {
  if (value === undefined || value === "") return fallback;
  const candidate =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return candidate;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    required.some((key) => !(key in input)) ||
    keys.some((key) => !required.includes(key))
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return input;
}

function identifier(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveRevision(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
