import { describe, expect, it } from "vitest";
import { parseBasisOpportunityTiming } from "./basisClock.js";

describe("basis venue-clock timing", () => {
  it("validates corrected age and skew without comparing raw venue clocks", () => {
    const parsed = parseBasisOpportunityTiming({
      correction: correction(),
      capturedAt: 100_000,
      spotExchange: "binance",
      futuresExchange: "bybit",
      spotExchangeTs: 105_000,
      futuresExchangeTs: 97_000,
      spotReceivedAt: 99_900,
      futuresReceivedAt: 99_900,
      quoteAgeMs: 104,
      legSkewMs: 4
    });

    expect(parsed).toMatchObject({
      measuredQuality: "fresh",
      clockCorrection: { modelVersion: "venue-clock-v1", skewEligible: true, maximumPossibleSkewMs: 4 }
    });
  });

  it("rejects tampered offset arithmetic and skew bounds", () => {
    const tamperedOffset = correction();
    tamperedOffset.spot.offsetLowerMs = 5_101;
    const tamperedSkew = correction();
    tamperedSkew.maximumPossibleSkewMs = 3;
    const input = {
      capturedAt: 100_000,
      spotExchange: "binance",
      futuresExchange: "bybit",
      spotExchangeTs: 105_000,
      futuresExchangeTs: 97_000,
      spotReceivedAt: 99_900,
      futuresReceivedAt: 99_900,
      quoteAgeMs: 104,
      legSkewMs: 4
    };

    expect(() => parseBasisOpportunityTiming({ ...input, correction: tamperedOffset })).toThrow(/ageLowerMs/);
    expect(() => parseBasisOpportunityTiming({ ...input, correction: tamperedSkew })).toThrow(/maximumPossibleSkewMs/);
  });

  it("keeps degraded calibration unverified", () => {
    const { minimumPossibleSkewMs: _minimum, maximumPossibleSkewMs: _maximum, ...base } = correction();
    const degraded = {
      ...base,
      spot: { ...base.spot, clockStatus: "degraded", eligible: false, quality: "degraded", reason: "clock-not-calibrated" },
      skewEligible: false,
      skewReason: "clock-not-calibrated"
    };

    expect(
      parseBasisOpportunityTiming({
        correction: degraded,
        capturedAt: 100_000,
        spotExchange: "binance",
        futuresExchange: "bybit",
        spotExchangeTs: 105_000,
        futuresExchangeTs: 97_000,
        spotReceivedAt: 99_900,
        futuresReceivedAt: 99_900,
        quoteAgeMs: 104,
        legSkewMs: 0
      }).measuredQuality
    ).toBe("unverified");
  });
});

function correction() {
  return {
    modelVersion: "venue-clock-v1",
    spot: {
      sourceId: "binance:public",
      clockStatus: "calibrated",
      eligible: true,
      quality: "verified",
      offsetLowerMs: 5_100,
      offsetUpperMs: 5_104,
      ageLowerMs: 100,
      ageUpperMs: 104
    },
    futures: {
      sourceId: "bybit:public",
      clockStatus: "calibrated",
      eligible: true,
      quality: "verified",
      offsetLowerMs: -2_900,
      offsetUpperMs: -2_896,
      ageLowerMs: 100,
      ageUpperMs: 104
    },
    skewEligible: true,
    minimumPossibleSkewMs: 0,
    maximumPossibleSkewMs: 4
  };
}
