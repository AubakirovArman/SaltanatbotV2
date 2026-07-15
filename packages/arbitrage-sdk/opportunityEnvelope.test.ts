import { describe, expect, it } from "vitest";
import {
  assertMarketOpportunityEnvelope,
  normalizeBasisOpportunity,
  normalizeNLegOpportunity,
  normalizeNativeSpreadOpportunity,
  validateMarketOpportunityEnvelope
} from "./opportunityEnvelope.js";
import type { NLegOpportunity } from "./nLegTypes.js";
import type { BasisOpportunity, NativeSpreadOpportunity } from "./types.js";

describe("market opportunity envelope", () => {
  it("normalizes basis economics without claiming paper or live execution", () => {
    const envelope = normalizeBasisOpportunity(basis());

    expect(envelope).toMatchObject({
      schemaVersion: "market-opportunity-v1",
      family: "cash-and-carry",
      economics: { grossEdgeBps: 30, netEdgeBps: 18, costCoverage: "aggregate-estimate" },
      execution: { paperPlan: "unsupported", live: "blocked", atomicity: "none" }
    });
    expect(envelope.legs.map((leg) => [leg.marketType, leg.side, leg.quantity])).toEqual([
      ["spot", "buy", 0.5],
      ["perpetual", "sell", 0.5]
    ]);
    expect(validateMarketOpportunityEnvelope(envelope)).toEqual({ ok: true, errors: [] });
  });

  it("marks verified N-leg research as paper-plan ready while keeping live blocked", () => {
    const envelope = normalizeNLegOpportunity(nLeg());

    expect(envelope.execution).toEqual({
      research: "available",
      paperPlan: "ready",
      live: "blocked",
      atomicity: "none",
      paperBlockers: [],
      liveBlockers: ["Live multi-leg execution is not supported by this research contract."]
    });
    expect(envelope.legs).toHaveLength(4);
    expect(assertMarketOpportunityEnvelope(envelope)).toBe(envelope);
  });

  it("represents a native spread as venue-atomic research but blocks action until sides are selected", () => {
    const envelope = normalizeNativeSpreadOpportunity(nativeSpread());

    expect(envelope.execution).toMatchObject({ atomicity: "venue-native", paperPlan: "blocked", live: "blocked" });
    expect(envelope.legs.every((leg) => leg.side === "derived")).toBe(true);
    expect(envelope).toMatchObject({
      economics: { twoSidedQuote: { bidPrice: 20, askPrice: 21, absoluteWidth: 1, priceUnit: "USDT" } },
      capacity: { quantity: 1.5, quantityUnit: "base", quantityAsset: "BTC" }
    });
    expect(envelope.legs.map((leg) => leg.quantityAsset)).toEqual(["BTC", "BTC"]);
    expect(envelope.blockers.map((item) => item.stage)).toEqual(["live-execution", "live-execution", "live-execution", "live-execution"]);
    expect(validateMarketOpportunityEnvelope(envelope).ok).toBe(true);

    const delayedScanRow = { ...nativeSpread(), exchangeTs: 6_000, matchingEngineTs: 5_999, receivedAt: 6_100, quoteAgeMs: 4_000 };
    const delayedScan = normalizeNativeSpreadOpportunity(delayedScanRow);
    expect(delayedScan.source.evaluatedAt).toBe(10_000);
    expect(delayedScan.evidence.quoteAgeMs).toBe(4_000);

    const stale = normalizeNativeSpreadOpportunity(nativeSpread(), { evaluatedAt: 10_000, now: 20_001 });
    expect(stale.evidence.dataQuality).toBe("stale");
    expect(stale.blockers[0]).toMatchObject({ code: "native-spread-quote-stale", stage: "market-data" });
  });

  it("fails closed when a ready plan has duplicate legs, derived sides or unverified continuity", () => {
    const envelope = normalizeNLegOpportunity(nLeg());
    envelope.legs[1].id = envelope.legs[0].id;
    envelope.legs[2].side = "derived";
    envelope.evidence.sequenceContinuity = "unverified";

    const result = validateMarketOpportunityEnvelope(envelope);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "legs[1].id must be unique",
      "ready paper plan requires concrete leg sides",
      "ready paper plan requires verified sequence continuity"
    ]));
    expect(() => assertMarketOpportunityEnvelope(envelope)).toThrow(/Invalid market opportunity envelope/);
  });
});

function basis(): BasisOpportunity {
  return {
    id: "basis:BTCUSDT",
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: "cross-venue-reviewed",
    symbol: "BTCUSDT",
    assetId: "BTC",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 1,
    futuresBid: 100.3,
    futuresAsk: 100.4,
    futuresBidSize: 0.5,
    grossSpreadBps: 30,
    estimatedTotalCostBps: 12,
    netEdgeBps: 18,
    topBookCapacityUsd: 50,
    topBookMatchedQuantity: 0.5,
    expectedNetProfitUsd: 0.09,
    fundingRate: 0.0001,
    nextFundingTime: 20_000,
    fundingIntervalMinutes: 480,
    fundingScheduleVerified: true,
    spotExchangeTs: 9_990,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: 9_995,
    futuresExchangeTs: 9_992,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: 9_997,
    quoteAgeMs: 5,
    legSkewMs: 2,
    dataQuality: "fresh",
    capturedAt: 10_000
  };
}

function nLeg(): NLegOpportunity {
  const assets = ["USDT", "A", "B", "C", "USDT"];
  const legs = Array.from({ length: 4 }, (_, index) => ({
    index,
    instrumentId: `test:${assets[index]}-${assets[index + 1]}`,
    venue: "test",
    symbol: `${assets[index]}-${assets[index + 1]}`,
    side: "sell" as const,
    from: { venue: "test", assetId: assets[index], unitId: "native" },
    to: { venue: "test", assetId: assets[index + 1], unitId: "native" },
    fromKey: `test:${assets[index]}:native`,
    toKey: `test:${assets[index + 1]}:native`,
    inputQuantity: 100,
    tradeInputQuantity: 100,
    totalInputDebitedQuantity: 100,
    inputDustQuantity: 0,
    orderBaseQuantity: 1,
    averagePrice: 100,
    worstPrice: 100,
    quoteNotional: 100,
    grossOutputQuantity: 101,
    feeScheduleId: `fee:${index}`,
    feeTierId: "vip-0",
    feeBps: 1,
    feeAsset: { venue: "test", assetId: assets[index + 1], unitId: "native" },
    feeAssetKey: `test:${assets[index + 1]}:native`,
    feeDebit: "output" as const,
    feeQuantity: 0.01,
    outputQuantity: 100.99,
    levelsUsed: 1,
    exchangeTs: 9_990 + index,
    receivedAt: 9_995 + index,
    sequence: index + 1
  }));
  return {
    id: "nleg:test-cycle",
    strategyKind: "n-leg-cycle",
    edgeKind: "research-simulation",
    executable: false,
    executionModel: "sequential-visible-depth",
    cycleId: "test-cycle",
    venue: "test",
    legCount: 4,
    start: { venue: "test", assetId: "USDT", unitId: "native" },
    startKey: "test:USDT:native",
    requestedStartQuantity: 100,
    startQuantity: 100,
    endQuantity: 101,
    netReturnBps: 100,
    capacityUtilizationPct: 10,
    depthLimited: false,
    legs,
    residuals: [],
    dustByAssetUnit: {},
    feesByAssetUnit: {},
    timestamps: {
      evaluatedAt: 10_000,
      oldestExchangeTs: 9_990,
      newestExchangeTs: 9_993,
      oldestReceivedAt: 9_995,
      newestReceivedAt: 9_998,
      quoteAgeMs: 10,
      legSkewMs: 3,
      sequenceVerified: true,
      exchangeTimestampsVerified: true
    },
    provenance: {
      engine: "n-leg-v1",
      canonicalSignature: "test-signature",
      instrumentIds: legs.map((leg) => leg.instrumentId),
      feeScheduleIds: legs.map((leg) => leg.feeScheduleId),
      bookSourceIds: legs.map((leg) => `book:${leg.instrumentId}`)
    }
  };
}

function nativeSpread(): NativeSpreadOpportunity {
  return {
    id: "bybit:native-spread:BTCUSDT-BTC-27SEP26",
    venue: "bybit",
    symbol: "BTCUSDT-BTC-27SEP26",
    contractType: "FutureSpread",
    status: "Trading",
    baseCoin: "BTC",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: 0.1,
    minimumPrice: -10_000,
    maximumPrice: 10_000,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    maximumQuantity: 100,
    launchTime: 1,
    deliveryTime: 20_000,
    legs: [
      { symbol: "BTCUSDT", contractType: "LinearPerpetual" },
      { symbol: "BTC-27SEP26", contractType: "LinearFutures" }
    ],
    bidPrice: 20,
    bidQuantity: 2,
    askPrice: 21,
    askQuantity: 1.5,
    bookWidth: 1,
    relativeBookWidthBps: 487.8,
    executableQuantity: 1.5,
    sequence: 10,
    exchangeTs: 9_990,
    matchingEngineTs: 9_991,
    receivedAt: 10_000,
    quoteAgeMs: 10,
    riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
  };
}
