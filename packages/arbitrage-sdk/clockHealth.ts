import { array, bool, exact, finite, integer, nonNegative, optionalFinite, optionalText, record, text } from "./validation.js";

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
  minimumObservedRoundTripMs?: number;
  offsetLowerMs?: number;
  offsetUpperMs?: number;
  offsetMidpointMs?: number;
  uncertaintyMs?: number;
  rejectedProbes: number;
  reason?: "no-samples" | "sample-expired" | "insufficient-consistent-samples" | "uncertainty-too-high";
  ok: boolean;
  endpoint: string;
  message?: string;
}

export interface VenueClockHealth {
  schemaVersion: 1;
  updatedAt: number;
  stale: boolean;
  sources: VenueClockHealthSource[];
}

export function parseVenueClockHealth(value: unknown): VenueClockHealth {
  const row = record(value, "venue clock health");
  if (row.schemaVersion !== 1) throw new Error("venue clock health schemaVersion must be 1");
  const updatedAt = positiveSafeTimestamp(row.updatedAt, "updatedAt");
  const stale = bool(row.stale, "stale");
  const sources = array(row.sources, "sources", 16).map((source, index) => parseVenueClockSource(source, updatedAt, `sources[${index}]`));
  if (sources.length < 1) throw new Error("venue clock health requires at least one source");
  if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) throw new Error("venue clock sourceId values must be unique");
  const measuredStale = sources.some(({ ok, status }) => !ok || status !== "calibrated");
  if (stale !== measuredStale) throw new Error("venue clock stale flag is inconsistent with source health");
  return { schemaVersion: 1, updatedAt, stale, sources };
}

function parseVenueClockSource(value: unknown, updatedAt: number, label: string): VenueClockHealthSource {
  const row = record(value, label);
  const sourceId = text(row.sourceId, `${label}.sourceId`);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(sourceId)) throw new Error(`${label}.sourceId is invalid`);
  const status = exact(row.status, ["calibrated", "degraded", "expired", "unavailable"] as const, `${label}.status`);
  const evaluatedAt = positiveSafeTimestamp(row.evaluatedAt, `${label}.evaluatedAt`);
  if (evaluatedAt !== updatedAt) throw new Error(`${label}.evaluatedAt must match updatedAt`);
  const sampleCount = safeNonNegativeInteger(row.sampleCount, `${label}.sampleCount`);
  const consistentSampleCount = safeNonNegativeInteger(row.consistentSampleCount, `${label}.consistentSampleCount`);
  if (consistentSampleCount > sampleCount) throw new Error(`${label}.consistentSampleCount exceeds sampleCount`);
  const rejectedProbes = safeNonNegativeInteger(row.rejectedProbes, `${label}.rejectedProbes`);
  const ok = bool(row.ok, `${label}.ok`);
  const endpoint = httpsUrl(row.endpoint, `${label}.endpoint`);
  const message = optionalText(row.message, `${label}.message`);
  const reason = row.reason === undefined ? undefined : exact(row.reason, ["no-samples", "sample-expired", "insufficient-consistent-samples", "uncertainty-too-high"] as const, `${label}.reason`);
  const sampledAt = optionalSafeTimestamp(row.sampledAt, `${label}.sampledAt`);
  const expiresAt = optionalSafeTimestamp(row.expiresAt, `${label}.expiresAt`);
  const roundTripMs = optionalNonNegative(row.roundTripMs, `${label}.roundTripMs`);
  const minimumObservedRoundTripMs = optionalNonNegative(row.minimumObservedRoundTripMs, `${label}.minimumObservedRoundTripMs`);
  const offsetLowerMs = optionalFinite(row.offsetLowerMs, `${label}.offsetLowerMs`);
  const offsetUpperMs = optionalFinite(row.offsetUpperMs, `${label}.offsetUpperMs`);
  const offsetMidpointMs = optionalFinite(row.offsetMidpointMs, `${label}.offsetMidpointMs`);
  const uncertaintyMs = optionalNonNegative(row.uncertaintyMs, `${label}.uncertaintyMs`);
  const timing = [sampledAt, expiresAt, roundTripMs, minimumObservedRoundTripMs, offsetLowerMs, offsetUpperMs, offsetMidpointMs, uncertaintyMs];
  if (status === "unavailable") {
    if (sampleCount !== 0 || consistentSampleCount !== 0 || reason !== "no-samples" || timing.some((item) => item !== undefined)) throw new Error(`${label} unavailable state contains calibrated timing fields`);
  } else {
    if (timing.some((item) => item === undefined) || sampledAt! > updatedAt || expiresAt! < sampledAt! || offsetLowerMs! > offsetUpperMs! || minimumObservedRoundTripMs! > roundTripMs!) throw new Error(`${label} timing interval is incomplete or inconsistent`);
    assertApproximately(offsetMidpointMs!, (offsetLowerMs! + offsetUpperMs!) / 2, `${label}.offsetMidpointMs`);
    assertApproximately(uncertaintyMs!, (offsetUpperMs! - offsetLowerMs!) / 2, `${label}.uncertaintyMs`);
    if (status === "calibrated" && reason !== undefined) throw new Error(`${label} calibrated state cannot include a degradation reason`);
    if (status === "expired" && reason !== "sample-expired") throw new Error(`${label} expired state requires sample-expired reason`);
    if (status === "degraded" && reason !== "insufficient-consistent-samples" && reason !== "uncertainty-too-high") throw new Error(`${label} degraded state requires a calibration reason`);
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
    ...(minimumObservedRoundTripMs === undefined ? {} : { minimumObservedRoundTripMs }),
    ...(offsetLowerMs === undefined ? {} : { offsetLowerMs }),
    ...(offsetUpperMs === undefined ? {} : { offsetUpperMs }),
    ...(offsetMidpointMs === undefined ? {} : { offsetMidpointMs }),
    ...(uncertaintyMs === undefined ? {} : { uncertaintyMs }),
    rejectedProbes,
    ...(reason === undefined ? {} : { reason }),
    ok,
    endpoint,
    ...(message === undefined ? {} : { message })
  };
}

function positiveSafeTimestamp(value: unknown, label: string) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function safeNonNegativeInteger(value: unknown, label: string) {
  return integer(value, label);
}

function optionalSafeTimestamp(value: unknown, label: string) {
  return value === undefined ? undefined : positiveSafeTimestamp(value, label);
}

function optionalNonNegative(value: unknown, label: string) {
  return value === undefined ? undefined : nonNegative(value, label);
}

function httpsUrl(value: unknown, label: string) {
  const parsed = text(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return parsed;
}

function assertApproximately(actual: number, expected: number, label: string) {
  const tolerance = 1e-8 * Math.max(1, Math.abs(expected));
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) throw new Error(`${label} is inconsistent with the clock interval`);
}
