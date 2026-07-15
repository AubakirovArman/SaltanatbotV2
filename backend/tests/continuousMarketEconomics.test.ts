import { describe, expect, it } from "vitest";
import type { PairwiseInstrument } from "../src/arbitrage/engines/pairwise/index.js";
import type { RouteFamily, RouteFamilyCandidate } from "../src/arbitrage/routeFamilies/index.js";
import type { CrossVenueSkewAssessment, ExchangeTimestampAssessment, VenueClockAssessmentProvider } from "../src/arbitrage/timing/index.js";
import { evaluateContinuousMarketEconomics } from "../src/arbitrage/upstream/publicFeeds/marketEconomics.js";
import type { ContinuousFeedStatus, ContinuousTopBook } from "../src/arbitrage/upstream/publicFeeds/types.js";

const NOW = 2_000_000_000_000;

describe("continuous market-only economics", () => {
  it("derives an exact discrete common top-book quantity and public-fee net entry edge", () => {
    const long = instrument("okx", "future", "long", { unit: "base" }, 0.003, 8);
    const short = instrument("gate", "future", "short", { unit: "contract", contractMultiplier: 0.002, multiplierAsset: "base" }, 2, 10);
    const result = evaluateContinuousMarketEconomics([candidate("calendar-spread", long, short)], [long, short], [book(long, 99, 100, 2, 1.004, 7), book(short, 101, 102, 251, 251, 8)], states(long, short), options());

    expect(result.marketEconomics).toEqual({
      engine: "continuous-market-economics-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      outcomeClass: "projected",
      evaluatedAt: NOW,
      totalCandidates: 1,
      evaluatedCandidates: 1,
      marketOnlyCandidates: 1,
      blockedCandidates: 0,
      publishedEvaluations: 1,
      publishedMarketOnlyCandidates: 1,
      publishedBlockedCandidates: 0,
      truncated: false,
      feePolicy: {
        version: "continuous-public-taker-fee-v1",
        source: "operator-environment",
        liquidity: "taker",
        discountsApplied: false,
        rebatesApplied: false,
        feeAssetVerified: false,
        exposureImpactIncluded: false,
        coverage: "entry-only"
      }
    });
    const evaluation = result.marketEvaluations[0];
    expect(evaluation).toMatchObject({
      status: "market-only",
      strategyStatus: "blocked",
      executable: false,
      baseAsset: "BTC",
      quoteAsset: "USDT",
      executionBoundary: { permission: false, orders: "not-supported" },
      capacity: {
        scope: "maximum-visible-top-book",
        matchedBaseQuantity: 0.492,
        commonBaseQuantity: 0.492,
        longAlignedBaseCapacity: 1.002,
        shortAlignedBaseCapacity: 0.5
      },
      legs: [
        {
          role: "long",
          usedNativeQuantity: 0.492,
          baseQuantity: 0.492,
          quoteNotional: 49.2,
          takerFeeBps: 8,
          publicEntryFeeQuoteEquivalentEstimate: 0.03936,
          feeAssumption: { feeAssetVerified: false, exposureImpactIncluded: false }
        },
        {
          role: "short",
          usedNativeQuantity: 246,
          baseQuantity: 0.492,
          quoteNotional: 49.692,
          takerFeeBps: 10,
          publicEntryFeeQuoteEquivalentEstimate: 0.049692,
          feeAssumption: { feeAssetVerified: false, exposureImpactIncluded: false }
        }
      ],
      freshness: {
        status: "fresh",
        clockBasis: "calibrated-venue-interval",
        crossVenueComparable: true,
        quoteAgeMs: 11,
        legSkewMs: 2,
        quoteAgeLowerMs: 9,
        quoteAgeUpperMs: 11,
        minimumPossibleLegSkewMs: 0,
        maximumPossibleLegSkewMs: 2
      },
      evidence: {
        marketDataComplete: true,
        continuityVerified: true,
        requiredStrategyEvidenceComplete: false,
        economicIdentities: [
          { instrumentId: long.instrumentId, economicAssetId: "crypto:bitcoin", source: "test", version: "2026-07", asOf: NOW - 1_000, validUntil: NOW + 10_000 },
          { instrumentId: short.instrumentId, economicAssetId: "crypto:bitcoin", source: "test", version: "2026-07", asOf: NOW - 1_000, validUntil: NOW + 10_000 }
        ]
      }
    });
    if (evaluation?.status !== "market-only") throw new Error("expected market-only evaluation");
    expect(evaluation.edges.grossEntryValueDifferenceQuote).toBeCloseTo(0.492, 12);
    expect(evaluation.edges.publicEntryFeesQuoteEquivalentEstimate).toBeCloseTo(0.089052, 12);
    expect(evaluation.edges.netEntryValueDifferenceAfterEstimatedFeesQuote).toBeCloseTo(0.402948, 12);
    expect(evaluation.blockedReasons.map(({ code }) => code)).toEqual(["convergence-evidence-missing", "derivative-margin-missing", "derivative-margin-missing", "expiry-delivery-evidence-missing"]);
  });

  it("pairs quote-native and base-native spot quantities without approximating requested size", () => {
    const long = instrument("okx", "spot", "long", { unit: "quote" }, 10, 5);
    const short = instrument("gate", "spot", "short", { unit: "base" }, 0.03, 5);
    const result = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], [book(long, 99, 100, 1_000, 1_000, 1), book(short, 101, 102, 0.95, 0.95, 1)], states(long, short), options());

    const evaluation = result.marketEvaluations[0];
    expect(evaluation).toMatchObject({
      status: "market-only",
      capacity: { scope: "maximum-visible-top-book", commonBaseQuantity: 0.9, matchedBaseQuantity: 0.9 },
      legs: [
        { usedNativeQuantity: 90, baseQuantity: 0.9 },
        { usedNativeQuantity: 0.9, baseQuantity: 0.9 }
      ]
    });
    expect(evaluation).not.toHaveProperty("requestedBaseQuantity");
  });

  it("blocks stale generations and continuity that is not protocol verified", () => {
    const long = instrument("okx", "spot", "long", { unit: "base" }, 0.001, 5);
    const short = instrument("gate", "spot", "short", { unit: "base" }, 0.001, 5);
    const longBook = book(long, 99, 100, 1, 1, 1);
    const shortBook = book(short, 101, 102, 1, 1, 1);
    longBook.continuity = { kind: "atomic-snapshot", protocol: "hyperliquid-block-snapshot", sequenceVerified: false };
    shortBook.connectionGeneration = 1;
    const sourceStates = states(long, short);
    sourceStates.set(short.instrumentId, { state: "live", generation: 2 });

    const result = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], [longBook, shortBook], sourceStates, options());

    expect(result.marketEvaluations[0]).toMatchObject({ status: "blocked", strategyStatus: "blocked", executable: false });
    expect(result.marketEvaluations[0]!.blockedReasons.map(({ code }) => code)).toEqual(expect.arrayContaining(["unverified-continuity", "generation-mismatch", "account-capital-missing", "network-rebalance-missing"]));
  });

  it("does not publish entry economics for an expired dated-future leg", () => {
    const long = instrument("okx", "spot", "long", { unit: "base" }, 0.001, 5);
    const short = { ...instrument("gate", "future", "short", { unit: "base" }, 0.001, 5), expiryTime: NOW };
    const result = evaluateContinuousMarketEconomics([candidate("spot-dated-future", long, short)], [long, short], [book(long, 99, 100, 1, 1, 1), book(short, 101, 102, 1, 1, 1)], states(long, short), options());

    expect(result.marketEvaluations[0]).toMatchObject({ status: "blocked", blockedReasons: expect.arrayContaining([{ code: "expiry-boundary", stage: "market-data", subject: short.instrumentId, message: expect.any(String) }]) });
  });

  it.each([
    ["not-yet-valid", { asOf: NOW + 1, validUntil: NOW + 10_000 }, "economic-identity-not-yet-valid"],
    ["expired", { asOf: NOW - 10_000, validUntil: NOW - 1 }, "economic-identity-expired"]
  ] as const)("fails closed when economic identity is %s at evaluatedAt", (_label, interval, code) => {
    const long = instrument("okx", "spot", "long", { unit: "base" }, 0.001, 5);
    const short = instrument("gate", "spot", "short", { unit: "base" }, 0.001, 5);
    long.economicIdentity = { ...long.economicIdentity, ...interval };
    const result = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], [book(long, 99, 100, 1, 1, 1), book(short, 101, 102, 1, 1, 1)], states(long, short), options());

    expect(result.marketEvaluations[0]).toMatchObject({
      status: "blocked",
      blockedReasons: expect.arrayContaining([expect.objectContaining({ code, stage: "market-data", subject: long.instrumentId })])
    });
  });

  it("accepts exact economic identity interval boundaries and publishes full ordered provenance", () => {
    const long = instrument("okx", "spot", "long", { unit: "base" }, 0.001, 5);
    const short = instrument("gate", "spot", "short", { unit: "base" }, 0.001, 5);
    long.economicIdentity = { ...long.economicIdentity, asOf: NOW, validUntil: NOW + 1 };
    short.economicIdentity = { ...short.economicIdentity, asOf: NOW - 1, validUntil: NOW };
    const result = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], [book(long, 99, 100, 1, 1, 1), book(short, 101, 102, 1, 1, 1)], states(long, short), options());

    expect(result.marketEvaluations[0]).toMatchObject({
      status: "market-only",
      evidence: {
        economicIdentities: [
          { instrumentId: long.instrumentId, asOf: NOW },
          { instrumentId: short.instrumentId, validUntil: NOW }
        ]
      }
    });
  });

  it.each([
    ["overflow", 9e307, 1e308, 10],
    ["fee underflow", 1e-323, 2e-323, 1]
  ] as const)("blocks derived arithmetic %s instead of publishing non-finite or underflowed economics", (_label, bid, ask, size) => {
    const long = instrument("okx", "spot", "long", { unit: "base" }, 1, 5);
    const short = instrument("gate", "spot", "short", { unit: "base" }, 1, 5);
    long.minimumNotional = Number.MIN_VALUE;
    short.minimumNotional = Number.MIN_VALUE;
    const result = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], [book(long, bid, ask, size, size, 1), book(short, ask * 1.1, ask * 1.2, size, size, 1)], states(long, short), options());

    expect(result.marketEvaluations[0]).toMatchObject({
      status: "blocked",
      blockedReasons: expect.arrayContaining([expect.objectContaining({ code: "derived-arithmetic-invalid", stage: "market-data" })])
    });
    expect(JSON.stringify(result)).not.toMatch(/null/);
  });

  it.each<[RouteFamily, string[]]>([
    ["cross-venue-spot-spot", ["account-capital-missing", "account-inventory-missing", "network-rebalance-missing"]],
    ["reverse-cash-and-carry", ["borrow-evidence-missing", "convergence-evidence-missing", "derivative-margin-missing", "funding-horizon-missing"]],
    ["perpetual-perpetual-funding", ["convergence-evidence-missing", "derivative-margin-missing", "funding-horizon-missing"]],
    ["spot-dated-future", ["account-capital-missing", "convergence-evidence-missing", "derivative-margin-missing", "expiry-delivery-evidence-missing"]],
    ["calendar-spread", ["convergence-evidence-missing", "derivative-margin-missing", "expiry-delivery-evidence-missing"]],
    ["perpetual-future", ["convergence-evidence-missing", "derivative-margin-missing", "expiry-delivery-evidence-missing", "funding-horizon-missing"]]
  ])("fails %s closed when server-owned account/horizon evidence is absent", (family, requiredCodes) => {
    const long = instrument("okx", marketTypes(family)[0], "long", { unit: "base" }, 0.001, 5);
    const short = instrument("gate", marketTypes(family)[1], "short", { unit: "base" }, 0.001, 5);
    const result = evaluateContinuousMarketEconomics([candidate(family, long, short)], [long, short], [book(long, 99, 100, 1, 1, 1), book(short, 101, 102, 1, 1, 1)], states(long, short), options());
    const evaluation = result.marketEvaluations[0]!;

    expect(evaluation).toMatchObject({ status: "market-only", strategyStatus: "blocked", executable: false });
    const actual = new Set(evaluation.blockedReasons.filter(({ stage }) => stage === "strategy-evidence").map(({ code }) => code));
    for (const code of requiredCodes) expect(actual).toContain(code);
  });

  it("bounds evaluations independently and reports truncation", () => {
    const instruments = ["a", "b", "c", "d"].map((suffix, index) => instrument(index % 2 === 0 ? "okx" : "gate", "spot", suffix, { unit: "base" }, 0.001, 5));
    const candidates = [candidate("cross-venue-spot-spot", instruments[0]!, instruments[1]!), candidate("cross-venue-spot-spot", instruments[0]!, instruments[3]!), candidate("cross-venue-spot-spot", instruments[2]!, instruments[1]!)];
    const result = evaluateContinuousMarketEconomics(candidates, instruments, [], new Map(), { ...options(), totalCandidates: 3, maxEvaluations: 2 });

    expect(result.marketEconomics).toMatchObject({
      totalCandidates: 3,
      evaluatedCandidates: 3,
      marketOnlyCandidates: 0,
      blockedCandidates: 3,
      publishedEvaluations: 2,
      publishedMarketOnlyCandidates: 0,
      publishedBlockedCandidates: 2,
      truncated: true
    });
    expect(result.marketEvaluations).toHaveLength(2);
  });

  it("ranks net quote value before a spectacular bps edge with negligible capacity", () => {
    const tinyLong = instrument("okx", "spot", "tiny-long", { unit: "base" }, 0.0001, 5);
    const tinyShort = instrument("gate", "spot", "tiny-short", { unit: "base" }, 0.0001, 5);
    const usefulLong = instrument("okx", "spot", "useful-long", { unit: "base" }, 0.001, 5);
    const usefulShort = instrument("gate", "spot", "useful-short", { unit: "base" }, 0.001, 5);
    tinyLong.minimumNotional = 0.001;
    tinyShort.minimumNotional = 0.001;
    const tiny = candidate("cross-venue-spot-spot", tinyLong, tinyShort);
    const useful = candidate("cross-venue-spot-spot", usefulLong, usefulShort);
    const instruments = [tinyLong, tinyShort, usefulLong, usefulShort];
    const books = [book(tinyLong, 99, 100, 0.0001, 0.0001, 1), book(tinyShort, 110, 111, 0.0001, 0.0001, 1), book(usefulLong, 99, 100, 100, 100, 1), book(usefulShort, 102, 103, 100, 100, 1)];
    const settings = { ...options(), totalCandidates: 2, maxEvaluations: 1 };

    const result = evaluateContinuousMarketEconomics([tiny, useful], instruments, books, states(...instruments), settings);
    const all = evaluateContinuousMarketEconomics([tiny, useful], instruments, books, states(...instruments), { ...settings, maxEvaluations: 2 });
    const tinyEvaluation = all.marketEvaluations.find(({ routeId }) => routeId === tiny.routeId);
    const usefulEvaluation = all.marketEvaluations.find(({ routeId }) => routeId === useful.routeId);
    if (tinyEvaluation?.status !== "market-only" || usefulEvaluation?.status !== "market-only") throw new Error("expected market-only ranking fixtures");
    expect(tinyEvaluation.edges.netEntryBasisAfterEstimatedFeesBps).toBeGreaterThan(usefulEvaluation.edges.netEntryBasisAfterEstimatedFeesBps);
    expect(tinyEvaluation.edges.netEntryValueDifferenceAfterEstimatedFeesQuote).toBeLessThan(usefulEvaluation.edges.netEntryValueDifferenceAfterEstimatedFeesQuote);
    expect(result.marketEvaluations[0]).toMatchObject({ routeId: useful.routeId });
    expect(result.marketEconomics).toMatchObject({ evaluatedCandidates: 2, publishedEvaluations: 1, truncated: true });
  });

  it("keeps blocked-row selection deterministic and fails closed on invalid work metadata", () => {
    const instruments = [instrument("okx", "spot", "z", { unit: "base" }, 0.001, 5), instrument("gate", "spot", "y", { unit: "base" }, 0.001, 5), instrument("okx", "spot", "x", { unit: "base" }, 0.001, 5), instrument("gate", "spot", "w", { unit: "base" }, 0.001, 5)];
    const candidates = [candidate("cross-venue-spot-spot", instruments[0]!, instruments[1]!), candidate("cross-venue-spot-spot", instruments[0]!, instruments[3]!), candidate("cross-venue-spot-spot", instruments[2]!, instruments[1]!)];
    const settings = { ...options(), totalCandidates: candidates.length, maxEvaluations: 2 };
    const first = evaluateContinuousMarketEconomics(candidates, instruments, [], new Map(), settings);
    const reversed = evaluateContinuousMarketEconomics([...candidates].reverse(), instruments, [], new Map(), settings);
    expect(first.marketEvaluations.every(({ status }) => status === "blocked")).toBe(true);
    expect(first.marketEvaluations.map(({ routeId }) => routeId)).toEqual(reversed.marketEvaluations.map(({ routeId }) => routeId));

    expect(() => evaluateContinuousMarketEconomics(candidates, instruments, [], new Map(), { ...settings, totalCandidates: 2 })).toThrow(/candidate total is inconsistent/);
    expect(() => evaluateContinuousMarketEconomics(candidates, instruments, [], new Map(), { ...settings, maxEvaluations: 501 })).toThrow(/between 1 and 500/);
    expect(() => evaluateContinuousMarketEconomics([candidates[0]!, candidates[0]!], instruments, [], new Map(), { ...settings, totalCandidates: 2 })).toThrow(/must be unique/);
  });

  it("blocks cross-venue economics when calibration is absent or expired", () => {
    const long = instrument("okx", "spot", "clock-long", { unit: "base" }, 0.001, 5);
    const short = instrument("gate", "spot", "clock-short", { unit: "base" }, 0.001, 5);
    const books = [book(long, 99, 100, 1, 1, 1), book(short, 101, 102, 1, 1, 1)];
    const noClock = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], books, states(long, short), { ...options(), clockCalibration: undefined });
    expect(noClock.marketEvaluations[0]).toMatchObject({
      status: "blocked",
      blockedReasons: expect.arrayContaining([expect.objectContaining({ code: "clock-unavailable", stage: "market-data" })])
    });

    const expired: VenueClockAssessmentProvider = {
      assessTimestamp(sourceId, exchangeTimestamp, evaluatedAt) {
        return { sourceId, exchangeTimestamp, evaluatedAt, clockStatus: "expired", eligible: false, quality: "degraded", reason: "clock-not-calibrated" };
      },
      assessSkew() {
        throw new Error("expired legs must never reach skew assessment");
      }
    };
    const staleClock = evaluateContinuousMarketEconomics([candidate("cross-venue-spot-spot", long, short)], [long, short], books, states(long, short), { ...options(), clockCalibration: expired });
    expect(staleClock.marketEvaluations[0]).toMatchObject({
      status: "blocked",
      blockedReasons: expect.arrayContaining([expect.objectContaining({ code: "clock-not-calibrated", stage: "market-data" })])
    });
  });
});

function options() {
  return { evaluatedAt: NOW, totalCandidates: 1, discoveryTruncated: false, maxEvaluations: 10, maxBookAgeMs: 1_000, maxLegSkewMs: 100, maxFutureClockSkewMs: 20, clockCalibration: calibratedClock };
}

const calibratedClock: VenueClockAssessmentProvider = {
  assessTimestamp(sourceId, exchangeTimestamp, evaluatedAt) {
    return {
      sourceId,
      exchangeTimestamp,
      evaluatedAt,
      clockStatus: "calibrated",
      eligible: true,
      quality: "verified",
      ageLowerMs: evaluatedAt - (exchangeTimestamp + 1),
      ageUpperMs: evaluatedAt - (exchangeTimestamp - 1),
      localEventEarliestAt: exchangeTimestamp - 1,
      localEventLatestAt: exchangeTimestamp + 1
    };
  },
  assessSkew(left, right, maximumSkewMs) {
    return exactSkew(left, right, maximumSkewMs);
  }
};

function exactSkew(left: ExchangeTimestampAssessment, right: ExchangeTimestampAssessment, maximumSkewMs: number): CrossVenueSkewAssessment {
  if (left.localEventEarliestAt === undefined || left.localEventLatestAt === undefined || right.localEventEarliestAt === undefined || right.localEventLatestAt === undefined) return { eligible: false, reason: "clock-unavailable" };
  const minimumPossibleSkewMs = left.localEventLatestAt < right.localEventEarliestAt ? right.localEventEarliestAt - left.localEventLatestAt : right.localEventLatestAt < left.localEventEarliestAt ? left.localEventEarliestAt - right.localEventLatestAt : 0;
  const maximumPossibleSkewMs = Math.max(Math.abs(left.localEventEarliestAt - right.localEventLatestAt), Math.abs(left.localEventLatestAt - right.localEventEarliestAt));
  return { eligible: maximumPossibleSkewMs <= maximumSkewMs, minimumPossibleSkewMs, maximumPossibleSkewMs, ...(maximumPossibleSkewMs > maximumSkewMs ? { reason: "skew-exceeded" as const } : {}) };
}

function instrument(venue: "okx" | "gate", marketType: PairwiseInstrument["marketType"], suffix: string, quantityModel: PairwiseInstrument["quantityModel"], quantityStep: number, takerFeeBps: number): PairwiseInstrument {
  return {
    instrumentId: `${venue}:${marketType}:BTC-USDT-${suffix}`,
    venue,
    symbol: `BTC-USDT-${suffix}`,
    marketType,
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: { status: "reviewed", source: "test", version: "2026-07", asOf: NOW - 1_000, validUntil: NOW + 10_000 },
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityModel,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional: 1,
    takerFeeBps,
    ...(marketType === "future" ? { expiryTime: NOW + 86_400_000 } : {})
  };
}

function candidate(family: RouteFamily, long: PairwiseInstrument, short: PairwiseInstrument): RouteFamilyCandidate {
  return {
    routeKey: JSON.stringify([family, long.instrumentId, short.instrumentId]),
    routeId: `rf:${family}:${long.instrumentId}:${short.instrumentId}`,
    family,
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    longMarketType: long.marketType,
    shortMarketType: short.marketType,
    economicAssetId: long.economicAssetId,
    edgeKind: "research-candidate",
    executable: false
  };
}

function book(instrument: PairwiseInstrument, bid: number, ask: number, bidSize: number, askSize: number, sequence: number): ContinuousTopBook {
  return {
    venue: instrument.venue as ContinuousTopBook["venue"],
    instrumentId: instrument.instrumentId,
    marketType: instrument.marketType,
    quantityUnit: instrument.quantityModel.unit,
    bid,
    bidSize,
    ask,
    askSize,
    exchangeTs: NOW - 10,
    receivedAt: NOW - 5,
    continuity: { kind: "sequence-verified", sequence, protocol: instrument.venue === "gate" ? "gate-update-id" : "okx-seqid" },
    connectionGeneration: 1
  };
}

function states(...instruments: PairwiseInstrument[]) {
  return new Map<string, Pick<ContinuousFeedStatus, "state" | "generation">>(instruments.map((value) => [value.instrumentId, { state: "live", generation: 1 }]));
}

function marketTypes(family: RouteFamily): readonly [PairwiseInstrument["marketType"], PairwiseInstrument["marketType"]] {
  if (family === "cross-venue-spot-spot") return ["spot", "spot"];
  if (family === "reverse-cash-and-carry") return ["perpetual", "spot"];
  if (family === "perpetual-perpetual-funding") return ["perpetual", "perpetual"];
  if (family === "spot-dated-future") return ["spot", "future"];
  if (family === "calendar-spread") return ["future", "future"];
  return ["perpetual", "future"];
}
