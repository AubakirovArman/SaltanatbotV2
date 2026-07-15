import { describe, expect, it } from "vitest";
import { applyVenueClockProbe, assessCrossVenueSkew, assessExchangeTimestamp, createVenueClockState, estimateVenueClock, type VenueClockPolicy, type VenueClockState } from "../src/arbitrage/timing/index.js";

const policy: Partial<VenueClockPolicy> = {
  minimumConsistentSamples: 2,
  maximumCalibratedUncertaintyMs: 20,
  maximumClockDriftPpm: 0,
  sampleTtlMs: 1_000,
  maximumProbeRoundTripMs: 100
};

function probe(state: VenueClockState, sourceId: string, sent: number, received: number, server: number) {
  return applyVenueClockProbe(state, { sourceId, localSentAt: sent, localReceivedAt: received, serverTime: server, serverResolutionMs: 1 }, policy).state;
}

describe("venue clock calibration", () => {
  it("keeps conservative RTT offset bounds and calibrates on compatible samples", () => {
    let state = createVenueClockState();
    state = probe(state, "binance:spot", 1_000, 1_020, 1_015);
    let estimate = estimateVenueClock(state, "binance:spot", 1_020, policy);
    expect(estimate).toMatchObject({ status: "degraded", offsetLowerMs: -6, offsetUpperMs: 16, offsetMidpointMs: 5, uncertaintyMs: 11 });
    state = probe(state, "binance:spot", 1_100, 1_110, 1_108);
    estimate = estimateVenueClock(state, "binance:spot", 1_110, policy);
    expect(estimate).toMatchObject({ status: "calibrated", sampleCount: 2, consistentSampleCount: 2, roundTripMs: 10, offsetLowerMs: -3, offsetUpperMs: 9 });
  });

  it("rejects slow probes without replacing a good calibration", () => {
    let state = createVenueClockState();
    state = probe(state, "bybit:public", 1_000, 1_010, 1_006);
    state = probe(state, "bybit:public", 1_020, 1_030, 1_026);
    const result = applyVenueClockProbe(state, { sourceId: "bybit:public", localSentAt: 1_100, localReceivedAt: 1_250, serverTime: 1_180, serverResolutionMs: 1 }, policy);
    expect(result).toMatchObject({ accepted: false, rejection: "round-trip-too-high", estimate: { status: "calibrated", rejectedProbes: 1 } });
    expect(result.state.sources["bybit:public"]?.samples).toHaveLength(2);
  });

  it("expires calibration and widens uncertainty by the configured drift bound", () => {
    let state = createVenueClockState();
    state = probe(state, "venue:a", 1_000, 1_010, 1_005);
    state = probe(state, "venue:a", 1_020, 1_030, 1_025);
    expect(estimateVenueClock(state, "venue:a", 2_031, policy)).toMatchObject({ status: "expired", reason: "sample-expired" });
    const drifted = estimateVenueClock(state, "venue:a", 1_530, { ...policy, maximumClockDriftPpm: 1_000 });
    expect(drifted.uncertaintyMs).toBeCloseTo(6.5);
  });

  it("returns a corrected age interval and fails closed on future or stale uncertainty", () => {
    let state = createVenueClockState();
    state = probe(state, "venue:a", 1_000, 1_010, 1_005);
    state = probe(state, "venue:a", 1_020, 1_030, 1_025);
    const fresh = assessExchangeTimestamp(state, "venue:a", 1_020, 1_040, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy);
    expect(fresh).toMatchObject({ eligible: true, quality: "verified", ageLowerMs: 14, ageUpperMs: 26 });
    expect(assessExchangeTimestamp(state, "venue:a", 1_050, 1_040, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy)).toMatchObject({ eligible: false, reason: "timestamp-may-be-future" });
    expect(assessExchangeTimestamp(state, "venue:a", 900, 1_040, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy)).toMatchObject({ eligible: false, reason: "timestamp-stale" });
  });

  it("uses worst-case corrected interval skew across venues", () => {
    let state = createVenueClockState();
    state = probe(state, "venue:a", 1_000, 1_010, 1_005);
    state = probe(state, "venue:a", 1_020, 1_030, 1_025);
    state = probe(state, "venue:b", 1_000, 1_010, 1_010);
    state = probe(state, "venue:b", 1_020, 1_030, 1_030);
    const left = assessExchangeTimestamp(state, "venue:a", 1_020, 1_040, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy);
    const right = assessExchangeTimestamp(state, "venue:b", 1_025, 1_040, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy);
    expect(assessCrossVenueSkew(left, right, 20)).toMatchObject({ eligible: true, minimumPossibleSkewMs: 0, maximumPossibleSkewMs: 12 });
    expect(assessCrossVenueSkew(left, right, 11)).toMatchObject({ eligible: false, reason: "skew-exceeded", maximumPossibleSkewMs: 12 });
  });

  it("does not synthesize clock verification when no probe exists", () => {
    const assessment = assessExchangeTimestamp(createVenueClockState(), "venue:none", 1_000, 1_010, { maximumAgeMs: 100, maximumFutureSkewMs: 10 }, policy);
    expect(assessment).toMatchObject({ eligible: false, quality: "unavailable", reason: "clock-unavailable" });
  });

  it("bounds samples and validates impossible probe order", () => {
    let state = createVenueClockState();
    state = applyVenueClockProbe(state, { sourceId: "venue:a", localSentAt: 1, localReceivedAt: 2, serverTime: 2, serverResolutionMs: 0 }, { ...policy, maximumSamples: 1, minimumConsistentSamples: 1 }).state;
    state = applyVenueClockProbe(state, { sourceId: "venue:a", localSentAt: 3, localReceivedAt: 4, serverTime: 4, serverResolutionMs: 0 }, { ...policy, maximumSamples: 1, minimumConsistentSamples: 1 }).state;
    expect(state.sources["venue:a"]?.samples).toHaveLength(1);
    expect(() => applyVenueClockProbe(state, { sourceId: "venue:a", localSentAt: 10, localReceivedAt: 9, serverTime: 10, serverResolutionMs: 0 }, policy)).toThrow(/must not precede/);
  });
});
