import {
  parseScreenerDefinitionV1,
  parseScreenerRunRequestV1,
  type ScreenerDefinitionV1,
  type ScreenerRunRequestV1,
} from "@saltanatbotv2/contracts";

export const SCREENER_REQUEST_BODY_BYTE_LIMIT = 32_768;

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface CreateScreenerPresetRequest {
  clientId: string;
  definition: ScreenerDefinitionV1;
}

export interface UpdateScreenerPresetRequest {
  expectedRevision: number;
  definition: ScreenerDefinitionV1;
}

export interface ScreenerPresetRevisionRequest {
  expectedRevision: number;
}

/** Wire body of POST /api/jobs for kind "screener"; presets resolve in the worker. */
export interface ScreenerRunJobRequest {
  clientRequestId: string;
  request: ScreenerRunRequestV1;
}

export function parseCreateScreenerPresetRequest(value: unknown): CreateScreenerPresetRequest {
  const input = exactObject(value, ["clientId", "definition"], "create screener preset");
  return {
    clientId: identifier(input.clientId, CLIENT_ID, "create screener preset.clientId"),
    definition: parseScreenerDefinitionV1(input.definition),
  };
}

export function parseUpdateScreenerPresetRequest(value: unknown): UpdateScreenerPresetRequest {
  const input = exactObject(
    value,
    ["expectedRevision", "definition"],
    "update screener preset",
  );
  return {
    expectedRevision: positiveRevision(
      input.expectedRevision,
      "update screener preset.expectedRevision",
    ),
    definition: parseScreenerDefinitionV1(input.definition),
  };
}

export function parseScreenerPresetRevisionRequest(
  value: unknown,
): ScreenerPresetRevisionRequest {
  const input = exactObject(
    value,
    ["expectedRevision"],
    "screener preset revision",
  );
  return {
    expectedRevision: positiveRevision(
      input.expectedRevision,
      "screener preset revision.expectedRevision",
    ),
  };
}

export function parseScreenerRunJobRequest(value: unknown): ScreenerRunJobRequest {
  const input = exactObject(
    value,
    ["kind", "clientRequestId", "request"],
    "screener run job",
  );
  if (input.kind !== "screener") {
    throw new Error("screener run job.kind must equal screener");
  }
  return {
    clientRequestId: identifier(
      input.clientRequestId,
      CLIENT_REQUEST_ID,
      "screener run job.clientRequestId",
    ),
    request: parseScreenerRunRequestV1(input.request),
  };
}

export function parseScreenerPageLimit(
  value: unknown,
  fallback = 100,
  maximum = 100,
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
