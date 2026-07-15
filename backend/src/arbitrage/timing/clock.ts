import type {
  CrossVenueSkewAssessment,
  ExchangeTimestampAssessment,
  VenueClockEstimate,
  VenueClockPolicy,
  VenueClockProbe,
  VenueClockProbeResult,
  VenueClockSample,
  VenueClockSourceState,
  VenueClockState
} from "./types.js";

export const DEFAULT_VENUE_CLOCK_POLICY: Readonly<VenueClockPolicy> = Object.freeze({
  maximumSamples: 32,
  minimumConsistentSamples: 3,
  sampleTtlMs: 5 * 60_000,
  maximumProbeRoundTripMs: 2_000,
  maximumCalibratedUncertaintyMs: 250,
  maximumClockDriftPpm: 100
});

export function createVenueClockState(): VenueClockState {
  return { schemaVersion: 1, sources: {} };
}

/**
 * Adds one NTP-style interval observation without reading a clock or performing
 * I/O. Offset is defined as `venue time - local time`.
 */
export function applyVenueClockProbe(previous: VenueClockState, probe: VenueClockProbe, input: Partial<VenueClockPolicy> = {}): VenueClockProbeResult {
  assertState(previous);
  const policy = resolveVenueClockPolicy(input);
  validateProbe(probe);
  const state = cloneState(previous);
  const source = state.sources[probe.sourceId] ?? emptySource();
  state.sources[probe.sourceId] = source;
  const roundTripMs = probe.localReceivedAt - probe.localSentAt;
  if (roundTripMs > policy.maximumProbeRoundTripMs) {
    source.rejectedProbes += 1;
    source.lastRejectedAt = probe.localReceivedAt;
    source.lastRejection = "round-trip-too-high";
    return {
      state,
      accepted: false,
      rejection: "round-trip-too-high",
      estimate: estimateVenueClock(state, probe.sourceId, probe.localReceivedAt, policy)
    };
  }

  const sample = sampleFromProbe(probe);
  source.samples = [...source.samples, sample]
    .sort((left, right) => left.localReceivedAt - right.localReceivedAt || left.roundTripMs - right.roundTripMs)
    .slice(-policy.maximumSamples);
  return { state, accepted: true, estimate: estimateVenueClock(state, probe.sourceId, probe.localReceivedAt, policy) };
}

export function estimateVenueClock(state: VenueClockState, sourceId: string, evaluatedAt: number, input: Partial<VenueClockPolicy> = {}): VenueClockEstimate {
  assertState(state);
  identifier(sourceId, "sourceId");
  timestamp(evaluatedAt, "evaluatedAt");
  const policy = resolveVenueClockPolicy(input);
  const source = state.sources[sourceId];
  if (!source || source.samples.length === 0) return unavailable(sourceId, evaluatedAt, source?.rejectedProbes ?? 0);

  const samples = source.samples.filter((sample) => sample.localReceivedAt <= evaluatedAt);
  if (samples.length === 0) return unavailable(sourceId, evaluatedAt, source.rejectedProbes);
  const best = samples.slice().sort((left, right) => widenedUncertainty(left, evaluatedAt, policy) - widenedUncertainty(right, evaluatedAt, policy) || right.localReceivedAt - left.localReceivedAt)[0]!;
  const ageMs = evaluatedAt - best.localReceivedAt;
  const drift = driftAllowance(ageMs, policy);
  const offsetLowerMs = best.offsetLowerMs - drift;
  const offsetUpperMs = best.offsetUpperMs + drift;
  const uncertaintyMs = (offsetUpperMs - offsetLowerMs) / 2;
  const consistentSampleCount = samples.filter((sample) => intervalsOverlap(
    [offsetLowerMs, offsetUpperMs],
    [sample.offsetLowerMs - driftAllowance(evaluatedAt - sample.localReceivedAt, policy), sample.offsetUpperMs + driftAllowance(evaluatedAt - sample.localReceivedAt, policy)]
  )).length;
  const common = {
    sourceId,
    evaluatedAt,
    sampleCount: samples.length,
    consistentSampleCount,
    sampledAt: best.localReceivedAt,
    expiresAt: best.localReceivedAt + policy.sampleTtlMs,
    roundTripMs: best.roundTripMs,
    minimumObservedRoundTripMs: Math.min(...samples.map(({ roundTripMs }) => roundTripMs)),
    offsetLowerMs,
    offsetUpperMs,
    offsetMidpointMs: (offsetLowerMs + offsetUpperMs) / 2,
    uncertaintyMs,
    rejectedProbes: source.rejectedProbes
  };
  if (ageMs > policy.sampleTtlMs) return { ...common, status: "expired", reason: "sample-expired" };
  if (consistentSampleCount < policy.minimumConsistentSamples) return { ...common, status: "degraded", reason: "insufficient-consistent-samples" };
  if (uncertaintyMs > policy.maximumCalibratedUncertaintyMs) return { ...common, status: "degraded", reason: "uncertainty-too-high" };
  return { ...common, status: "calibrated" };
}

export function assessExchangeTimestamp(
  state: VenueClockState,
  sourceId: string,
  exchangeTimestamp: number,
  evaluatedAt: number,
  limits: { maximumAgeMs: number; maximumFutureSkewMs: number },
  input: Partial<VenueClockPolicy> = {}
): ExchangeTimestampAssessment {
  timestamp(exchangeTimestamp, "exchangeTimestamp");
  timestamp(evaluatedAt, "evaluatedAt");
  nonNegative(limits.maximumAgeMs, "maximumAgeMs");
  nonNegative(limits.maximumFutureSkewMs, "maximumFutureSkewMs");
  const clock = estimateVenueClock(state, sourceId, evaluatedAt, input);
  if (clock.offsetLowerMs === undefined || clock.offsetUpperMs === undefined) {
    return { sourceId, exchangeTimestamp, evaluatedAt, clockStatus: clock.status, eligible: false, quality: "unavailable", reason: "clock-unavailable" };
  }
  const localEventEarliestAt = exchangeTimestamp - clock.offsetUpperMs;
  const localEventLatestAt = exchangeTimestamp - clock.offsetLowerMs;
  const ageLowerMs = evaluatedAt - localEventLatestAt;
  const ageUpperMs = evaluatedAt - localEventEarliestAt;
  const common = { sourceId, exchangeTimestamp, evaluatedAt, clockStatus: clock.status, ageLowerMs, ageUpperMs, localEventEarliestAt, localEventLatestAt };
  if (clock.status !== "calibrated") return { ...common, eligible: false, quality: "degraded", reason: "clock-not-calibrated" };
  if (ageUpperMs < -limits.maximumFutureSkewMs) return { ...common, eligible: false, quality: "verified", reason: "timestamp-definitely-future" };
  if (ageLowerMs < -limits.maximumFutureSkewMs) return { ...common, eligible: false, quality: "verified", reason: "timestamp-may-be-future" };
  if (ageUpperMs > limits.maximumAgeMs) return { ...common, eligible: false, quality: "verified", reason: "timestamp-stale" };
  return { ...common, eligible: true, quality: "verified" };
}

export function assessCrossVenueSkew(left: ExchangeTimestampAssessment, right: ExchangeTimestampAssessment, maximumSkewMs: number): CrossVenueSkewAssessment {
  nonNegative(maximumSkewMs, "maximumSkewMs");
  if (left.localEventEarliestAt === undefined || left.localEventLatestAt === undefined || right.localEventEarliestAt === undefined || right.localEventLatestAt === undefined) return { eligible: false, reason: "clock-unavailable" };
  if (left.clockStatus !== "calibrated" || right.clockStatus !== "calibrated") return { eligible: false, reason: "clock-not-calibrated" };
  const minimumPossibleSkewMs = intervalDistance([left.localEventEarliestAt, left.localEventLatestAt], [right.localEventEarliestAt, right.localEventLatestAt]);
  const maximumPossibleSkewMs = Math.max(
    Math.abs(left.localEventEarliestAt - right.localEventLatestAt),
    Math.abs(left.localEventLatestAt - right.localEventEarliestAt)
  );
  return {
    eligible: left.eligible && right.eligible && maximumPossibleSkewMs <= maximumSkewMs,
    minimumPossibleSkewMs,
    maximumPossibleSkewMs,
    ...(maximumPossibleSkewMs > maximumSkewMs ? { reason: "skew-exceeded" as const } : {})
  };
}

export function resolveVenueClockPolicy(input: Partial<VenueClockPolicy> = {}): VenueClockPolicy {
  const policy = { ...DEFAULT_VENUE_CLOCK_POLICY, ...input };
  integer(policy.maximumSamples, "maximumSamples", 1, 256);
  integer(policy.minimumConsistentSamples, "minimumConsistentSamples", 1, policy.maximumSamples);
  integer(policy.sampleTtlMs, "sampleTtlMs", 1, 24 * 60 * 60_000);
  integer(policy.maximumProbeRoundTripMs, "maximumProbeRoundTripMs", 1, 60_000);
  nonNegative(policy.maximumCalibratedUncertaintyMs, "maximumCalibratedUncertaintyMs");
  nonNegative(policy.maximumClockDriftPpm, "maximumClockDriftPpm");
  return policy;
}

function sampleFromProbe(probe: VenueClockProbe): VenueClockSample {
  const roundTripMs = probe.localReceivedAt - probe.localSentAt;
  const offsetLowerMs = probe.serverTime - probe.localReceivedAt - probe.serverResolutionMs;
  const offsetUpperMs = probe.serverTime - probe.localSentAt + probe.serverResolutionMs;
  return {
    localSentAt: probe.localSentAt,
    localReceivedAt: probe.localReceivedAt,
    serverTime: probe.serverTime,
    serverResolutionMs: probe.serverResolutionMs,
    roundTripMs,
    offsetLowerMs,
    offsetUpperMs,
    offsetMidpointMs: (offsetLowerMs + offsetUpperMs) / 2,
    uncertaintyMs: (offsetUpperMs - offsetLowerMs) / 2
  };
}

function validateProbe(probe: VenueClockProbe) {
  identifier(probe.sourceId, "sourceId");
  timestamp(probe.localSentAt, "localSentAt");
  timestamp(probe.localReceivedAt, "localReceivedAt");
  timestamp(probe.serverTime, "serverTime");
  nonNegative(probe.serverResolutionMs, "serverResolutionMs");
  if (probe.localReceivedAt < probe.localSentAt) throw new TypeError("localReceivedAt must not precede localSentAt");
}

function unavailable(sourceId: string, evaluatedAt: number, rejectedProbes: number): VenueClockEstimate {
  return { sourceId, status: "unavailable", evaluatedAt, sampleCount: 0, consistentSampleCount: 0, rejectedProbes, reason: "no-samples" };
}

function emptySource(): VenueClockSourceState {
  return { samples: [], rejectedProbes: 0 };
}

function widenedUncertainty(sample: VenueClockSample, evaluatedAt: number, policy: VenueClockPolicy) {
  return sample.uncertaintyMs + driftAllowance(evaluatedAt - sample.localReceivedAt, policy);
}

function driftAllowance(ageMs: number, policy: VenueClockPolicy) {
  return Math.max(0, ageMs) * (policy.maximumClockDriftPpm / 1_000_000);
}

function intervalsOverlap(left: [number, number], right: [number, number]) {
  return Math.max(left[0], right[0]) <= Math.min(left[1], right[1]);
}

function intervalDistance(left: [number, number], right: [number, number]) {
  if (intervalsOverlap(left, right)) return 0;
  return Math.max(left[0], right[0]) - Math.min(left[1], right[1]);
}

function assertState(state: VenueClockState) {
  if (state?.schemaVersion !== 1 || !state.sources || typeof state.sources !== "object") throw new TypeError("Invalid venue clock state");
}

function cloneState(state: VenueClockState): VenueClockState {
  return {
    schemaVersion: 1,
    sources: Object.fromEntries(Object.entries(state.sources).map(([key, source]) => [key, { ...source, samples: source.samples.map((sample) => ({ ...sample })) }]))
  };
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(value)) throw new TypeError(`${name} is invalid`);
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function nonNegative(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
}

function integer(value: unknown, name: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
}
