export type VenueClockStatus = "calibrated" | "degraded" | "expired" | "unavailable";

export interface VenueClockHealthSource {
  sourceId: string;
  status: VenueClockStatus;
  evaluatedAt: number;
  sampleCount: number;
  consistentSampleCount: number;
  sampledAt?: number;
  expiresAt?: number;
  roundTripMs?: number;
  offsetMidpointMs?: number;
  uncertaintyMs?: number;
  rejectedProbes: number;
  reason?: "no-samples" | "sample-expired" | "insufficient-consistent-samples" | "uncertainty-too-high";
  ok: boolean;
  message?: string;
}

export interface VenueClockHealth {
  schemaVersion: 1;
  updatedAt: number;
  stale: boolean;
  sources: VenueClockHealthSource[];
}

export async function fetchVenueClockHealth(signal?: AbortSignal): Promise<VenueClockHealth> {
  const response = await fetch("/api/arbitrage/clock-health", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Venue clock API ${response.status}`);
  }
  return parseVenueClockHealth(await response.json());
}

export function parseVenueClockHealth(value: unknown): VenueClockHealth {
  const input = object(value, "venue clock health");
  if (input.schemaVersion !== 1) throw new Error("venue clock schemaVersion is unsupported");
  const updatedAt = positiveSafeInteger(input.updatedAt, "clock.updatedAt");
  const stale = boolean(input.stale, "clock.stale");
  const sources = array(input.sources, "clock.sources", 16).map((value, index) => parseSource(value, updatedAt, index));
  if (sources.length === 0 || new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) throw new Error("clock sources must be non-empty and unique");
  if (stale !== sources.some(({ ok, status }) => !ok || status !== "calibrated")) throw new Error("clock stale flag is inconsistent with sources");
  return { schemaVersion: 1, updatedAt, stale, sources };
}

function parseSource(value: unknown, updatedAt: number, index: number): VenueClockHealthSource {
  const label = `clock.sources[${index}]`;
  const row = object(value, label);
  const sourceId = text(row.sourceId, `${label}.sourceId`);
  const status = clockStatus(row.status, `${label}.status`);
  const evaluatedAt = positiveSafeInteger(row.evaluatedAt, `${label}.evaluatedAt`);
  if (evaluatedAt !== updatedAt) throw new Error("clock source evaluatedAt must match updatedAt");
  const sampleCount = nonNegativeSafeInteger(row.sampleCount, `${label}.sampleCount`);
  const consistentSampleCount = nonNegativeSafeInteger(row.consistentSampleCount, `${label}.consistentSampleCount`);
  if (consistentSampleCount > sampleCount) throw new Error("clock consistentSampleCount exceeds sampleCount");
  const sampledAt = optionalPositiveSafeInteger(row.sampledAt, `${label}.sampledAt`);
  const expiresAt = optionalPositiveSafeInteger(row.expiresAt, `${label}.expiresAt`);
  const roundTripMs = optionalNonNegative(row.roundTripMs, `${label}.roundTripMs`);
  const offsetMidpointMs = optionalFinite(row.offsetMidpointMs, `${label}.offsetMidpointMs`);
  const uncertaintyMs = optionalNonNegative(row.uncertaintyMs, `${label}.uncertaintyMs`);
  const rejectedProbes = nonNegativeSafeInteger(row.rejectedProbes, `${label}.rejectedProbes`);
  const reason = clockReason(row.reason, status, `${label}.reason`);
  const ok = boolean(row.ok, `${label}.ok`);
  const message = row.message === undefined ? undefined : text(row.message, `${label}.message`);
  if (status === "unavailable") {
    if (sampleCount !== 0 || consistentSampleCount !== 0 || sampledAt !== undefined || expiresAt !== undefined || roundTripMs !== undefined || offsetMidpointMs !== undefined || uncertaintyMs !== undefined) throw new Error("unavailable clock source contains invented timing");
  } else if (sampledAt === undefined || expiresAt === undefined || roundTripMs === undefined || offsetMidpointMs === undefined || uncertaintyMs === undefined || sampledAt > updatedAt || expiresAt < sampledAt) {
    throw new Error("clock source timing is incomplete or inconsistent");
  }
  return {
    sourceId,
    status,
    evaluatedAt,
    sampleCount,
    consistentSampleCount,
    ...(sampledAt === undefined ? {} : { sampledAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(roundTripMs === undefined ? {} : { roundTripMs }),
    ...(offsetMidpointMs === undefined ? {} : { offsetMidpointMs }),
    ...(uncertaintyMs === undefined ? {} : { uncertaintyMs }),
    rejectedProbes,
    ...(reason === undefined ? {} : { reason }),
    ok,
    ...(message === undefined ? {} : { message })
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} rows`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function optionalFinite(value: unknown, label: string) {
  return value === undefined ? undefined : finite(value, label);
}

function nonNegative(value: unknown, label: string) {
  const result = finite(value, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

function optionalNonNegative(value: unknown, label: string) {
  return value === undefined ? undefined : nonNegative(value, label);
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  const result = nonNegative(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be a safe integer`);
  return result;
}

function positiveSafeInteger(value: unknown, label: string) {
  const result = nonNegativeSafeInteger(value, label);
  if (result === 0) throw new Error(`${label} must be positive`);
  return result;
}

function optionalPositiveSafeInteger(value: unknown, label: string) {
  return value === undefined ? undefined : positiveSafeInteger(value, label);
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function clockStatus(value: unknown, label: string): VenueClockStatus {
  if (value !== "calibrated" && value !== "degraded" && value !== "expired" && value !== "unavailable") throw new Error(`${label} is unsupported`);
  return value;
}

function clockReason(value: unknown, status: VenueClockStatus, label: string): VenueClockHealthSource["reason"] {
  if (status === "calibrated") {
    if (value !== undefined) throw new Error(`${label} must be omitted for a calibrated source`);
    return undefined;
  }
  if (value !== "no-samples" && value !== "sample-expired" && value !== "insufficient-consistent-samples" && value !== "uncertainty-too-high") throw new Error(`${label} is unsupported`);
  if ((status === "unavailable" && value !== "no-samples") || (status === "expired" && value !== "sample-expired") || (status === "degraded" && value !== "insufficient-consistent-samples" && value !== "uncertainty-too-high")) throw new Error(`${label} does not match clock status`);
  return value;
}
