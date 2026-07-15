import { describe, expect, it } from "vitest";
import { refreshOpportunityQuality, type ArbitrageClockCalibration } from "../src/arbitrage/service.js";
import type { ArbitrageOpportunity } from "../src/arbitrage/types.js";
import type { ExchangeTimestampAssessment } from "../src/arbitrage/timing/types.js";

describe("clock-corrected basis ranking", () => {
  it("accepts synchronized event times even when raw venue clocks differ by seconds", () => {
    const opportunity = fixture({ spotExchangeTs: 105_000, futuresExchangeTs: 97_000 });
    const calibration = clockCalibration({
      "binance:public": assessment("binance:public", 105_000, 100, 104),
      "bybit:public": assessment("bybit:public", 97_000, 100, 104)
    });

    const corrected = refreshOpportunityQuality(opportunity, 100_000, calibration);

    expect(corrected).toMatchObject({ dataQuality: "fresh", quoteAgeMs: 104, legSkewMs: 4 });
    expect(corrected.clockCorrection).toMatchObject({
      modelVersion: "venue-clock-v1",
      spot: { sourceId: "binance:public", offsetLowerMs: 5_100, offsetUpperMs: 5_104 },
      futures: { sourceId: "bybit:public", offsetLowerMs: -2_900, offsetUpperMs: -2_896 },
      skewEligible: true,
      maximumPossibleSkewMs: 4
    });
  });

  it("fails closed when either venue clock is not calibrated", () => {
    const opportunity = fixture();
    const degraded = assessment("binance:public", 99_900, 100, 110, "degraded");
    const calibration = clockCalibration({
      "binance:public": degraded,
      "bybit:public": assessment("bybit:public", 99_900, 100, 110)
    });

    expect(refreshOpportunityQuality(opportunity, 100_000, calibration)).toMatchObject({
      dataQuality: "unverified",
      clockCorrection: { spot: { clockStatus: "degraded", reason: "clock-not-calibrated" }, skewReason: "clock-not-calibrated" }
    });
  });

  it("keeps corrected stale and uncertain-skew states out of the fresh class", () => {
    const opportunity = fixture();
    const stale = clockCalibration({
      "binance:public": assessment("binance:public", 99_900, 10_001, 10_004, "calibrated", "timestamp-stale"),
      "bybit:public": assessment("bybit:public", 99_900, 100, 104)
    });
    const skewed = clockCalibration({
      "binance:public": assessment("binance:public", 99_900, 100, 104),
      "bybit:public": assessment("bybit:public", 99_900, 3_200, 3_204)
    });

    expect(refreshOpportunityQuality(opportunity, 100_000, stale).dataQuality).toBe("stale");
    expect(refreshOpportunityQuality(opportunity, 100_000, skewed)).toMatchObject({ dataQuality: "skewed", legSkewMs: 3_104 });
  });
});

function assessment(sourceId: string, exchangeTimestamp: number, ageLowerMs: number, ageUpperMs: number, clockStatus: ExchangeTimestampAssessment["clockStatus"] = "calibrated", reason?: ExchangeTimestampAssessment["reason"]): ExchangeTimestampAssessment {
  const evaluatedAt = 100_000;
  const localEventEarliestAt = evaluatedAt - ageUpperMs;
  const localEventLatestAt = evaluatedAt - ageLowerMs;
  return {
    sourceId,
    exchangeTimestamp,
    evaluatedAt,
    clockStatus,
    eligible: clockStatus === "calibrated" && reason === undefined,
    quality: clockStatus === "calibrated" ? "verified" : "degraded",
    ageLowerMs,
    ageUpperMs,
    localEventEarliestAt,
    localEventLatestAt,
    ...(reason ? { reason } : clockStatus === "calibrated" ? {} : { reason: "clock-not-calibrated" as const })
  };
}

function clockCalibration(assessments: Record<string, ExchangeTimestampAssessment>): ArbitrageClockCalibration {
  return {
    async snapshot() {},
    assessTimestamp(sourceId) {
      const value = assessments[sourceId];
      if (!value) throw new Error(`Missing assessment for ${sourceId}`);
      return value;
    },
    assessSkew(left, right, maximumSkewMs) {
      if (left.clockStatus !== "calibrated" || right.clockStatus !== "calibrated") return { eligible: false, reason: "clock-not-calibrated" };
      const minimumPossibleSkewMs = Math.max(0, Math.max(left.localEventEarliestAt!, right.localEventEarliestAt!) - Math.min(left.localEventLatestAt!, right.localEventLatestAt!));
      const maximumPossibleSkewMs = Math.max(Math.abs(left.localEventEarliestAt! - right.localEventLatestAt!), Math.abs(left.localEventLatestAt! - right.localEventEarliestAt!));
      return {
        eligible: left.eligible && right.eligible && maximumPossibleSkewMs <= maximumSkewMs,
        minimumPossibleSkewMs,
        maximumPossibleSkewMs,
        ...(maximumPossibleSkewMs > maximumSkewMs ? { reason: "skew-exceeded" as const } : {})
      };
    }
  };
}

function fixture(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: "BTCUSDT:binance:bybit",
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: "cross-venue-reviewed",
    symbol: "BTCUSDT",
    assetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 1,
    futuresBid: 103,
    futuresAsk: 104,
    futuresBidSize: 1,
    grossSpreadBps: 300,
    estimatedTotalCostBps: 0,
    netEdgeBps: 300,
    topBookCapacityUsd: 100,
    topBookMatchedQuantity: 1,
    expectedNetProfitUsd: 3,
    fundingRate: 0,
    fundingScheduleVerified: true,
    spotExchangeTs: 99_900,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: 99_900,
    futuresExchangeTs: 99_900,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: 99_900,
    quoteAgeMs: 100,
    legSkewMs: 0,
    dataQuality: "fresh",
    capturedAt: 100_000,
    ...overrides
  };
}
