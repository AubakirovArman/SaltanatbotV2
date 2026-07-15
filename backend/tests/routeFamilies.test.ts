import { describe, expect, it } from "vitest";
import type {
  PairwiseBookSnapshot,
  PairwiseInstrument
} from "../src/arbitrage/engines/pairwise/index.js";
import {
  discoverRouteFamilyCandidates,
  evaluateRouteFamilies,
  routeFamilyScopeKey,
  type RouteFamily,
  type RouteFamilyAssumptionCatalog,
  type RouteFamilyScope
} from "../src/arbitrage/routeFamilies/index.js";

const NOW = 2_000_000_000_000;
const DAY = 86_400_000;

describe("deterministic route-family research discovery", () => {
  it("discovers every requested family independent of metadata order", () => {
    const instruments = fixtures();
    const expected: Record<RouteFamily, number> = {
      "cross-venue-spot-spot": 2,
      "reverse-cash-and-carry": 4,
      "perpetual-perpetual-funding": 2,
      "spot-dated-future": 4,
      "calendar-spread": 2,
      "perpetual-future": 8
    };
    for (const [family, count] of Object.entries(expected) as Array<[RouteFamily, number]>) {
      const first = discoverRouteFamilyCandidates(instruments, { families: [family], maxCandidates: 100 });
      const second = discoverRouteFamilyCandidates([...instruments].reverse(), { families: [family], maxCandidates: 100 });
      expect(first.totalCompatibleCandidates).toBe(count);
      expect(first.candidates).toEqual(second.candidates);
      expect(first.candidates.every((candidate) => candidate.executable === false && candidate.edgeKind === "research-candidate")).toBe(true);
      expect(new Set(first.candidates.map((candidate) => candidate.routeId)).size).toBe(count);
    }
  });

  it("fails closed on unreviewed/mismatched identity and quote-valued contracts", () => {
    const left = instrument("a:spot:BTCUSDT", "a", "spot");
    const mismatch = { ...instrument("b:spot:BTCUSDT", "b", "spot"), economicAssetId: "crypto:wrapped-bitcoin" };
    expect(discoverRouteFamilyCandidates([left, mismatch], { families: ["cross-venue-spot-spot"] }).candidates).toEqual([]);

    const invalid = { ...left, economicIdentity: { ...left.economicIdentity, status: "unknown" } } as unknown as PairwiseInstrument;
    const invalidResult = discoverRouteFamilyCandidates([invalid, instrument("b:spot:BTCUSDT", "b", "spot")]);
    expect(invalidResult.rejectedInstruments).toEqual([expect.objectContaining({ instrumentId: left.instrumentId, code: "invalid-route" })]);

    const inverse = instrument("b:perpetual:BTCUSD", "b", "perpetual", undefined, { unit: "contract", contractMultiplier: 100, multiplierAsset: "quote" });
    expect(discoverRouteFamilyCandidates([left, inverse], { families: ["reverse-cash-and-carry"] }).candidates).toEqual([]);
  });

  it("applies a deterministic hard result bound without changing total count", () => {
    const result = discoverRouteFamilyCandidates(fixtures(), { maxCandidates: 3 });
    expect(result).toMatchObject({ truncated: true, totalCompatibleCandidates: 22 });
    expect(result.candidates).toHaveLength(3);
  });
});

describe("route-family evaluation", () => {
  it.each([
    { family: "cross-venue-spot-spot" as const, long: instrument("a:spot:BTCUSDT", "a", "spot"), short: instrument("b:spot:BTCUSDT", "b", "spot") },
    { family: "reverse-cash-and-carry" as const, long: instrument("a:perpetual:BTCUSDT", "a", "perpetual"), short: instrument("a:spot:BTCUSDT", "a", "spot") },
    { family: "perpetual-perpetual-funding" as const, long: instrument("a:perpetual:BTCUSDT", "a", "perpetual"), short: instrument("b:perpetual:BTCUSDT", "b", "perpetual") },
    { family: "spot-dated-future" as const, long: instrument("a:spot:BTCUSDT", "a", "spot"), short: instrument("a:future:BTC-NEAR", "a", "future", NOW + 30 * DAY) },
    { family: "calendar-spread" as const, long: instrument("a:future:BTC-NEAR", "a", "future", NOW + 30 * DAY), short: instrument("a:future:BTC-FAR", "a", "future", NOW + 60 * DAY) },
    { family: "perpetual-future" as const, long: instrument("a:perpetual:BTCUSDT", "a", "perpetual"), short: instrument("a:future:BTC-NEAR", "a", "future", NOW + 30 * DAY) }
  ])("materializes and evaluates $family only as research", ({ family, long, short }) => {
    const result = evaluateOne(family, long, short);
    expect(result).toMatchObject({ engine: "route-families-v1", executionStatus: "research-only", executable: false, evaluatedAt: NOW });
    expect(result.evaluatedRoutes).toBe(1);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({ executable: false, edgeKind: "research-simulation", economicAssetId: "crypto:bitcoin" });
    expect(result.opportunities[0]!.riskFlags).toContain("simultaneous-execution-not-guaranteed");
    expect(result.opportunities[0]!.provenance.assumptions.length).toBeGreaterThan(0);
  });

  it("does not synthesize account, funding, convergence or delivery assumptions", () => {
    const long = instrument("a:perpetual:BTCUSDT", "a", "perpetual");
    const short = instrument("b:perpetual:BTCUSDT", "b", "perpetual");
    const result = evaluateRouteFamilies({
      instruments: [long, short],
      books: [book(long, 99, 100), book(short, 105, 106)],
      assumptions: emptyCatalog(),
      families: ["perpetual-perpetual-funding"],
      maxRoutes: 10,
      options: evaluationOptions()
    });
    expect(result.evaluatedRoutes).toBe(0);
    expect(result.opportunities).toEqual([]);
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections.every((rejection) => rejection.code === "missing-assumption")).toBe(true);
  });

  it("caps a spot buy by explicitly verified quote capital", () => {
    const long = instrument("a:spot:BTCUSDT", "a", "spot");
    const short = instrument("b:spot:BTCUSDT", "b", "spot");
    const scope = routeScope("cross-venue-spot-spot", long, short, 2);
    const assumptions = catalog(scope, long, short);
    assumptions.capital = [{ ...assumptions.capital[0]!, availableQuoteQuantity: 150 }];
    const longBook = { ...book(long, 99, 100), asks: [[100, 1], [1_000, 100]] as const };
    const result = evaluateRouteFamilies({
      instruments: [long, short],
      books: [longBook, book(short, 2_000, 2_001)],
      assumptions,
      families: ["cross-venue-spot-spot"],
      maxRoutes: 10,
      options: evaluationOptions()
    });
    expect(result.opportunities[0]).toMatchObject({ requestedBaseQuantity: 2, executableBaseQuantity: 1.05 });
    expect(result.opportunities[0]!.riskFlags).toEqual(expect.arrayContaining(["prefunded-quote-capital", "capital-limited"]));
    expect(result.opportunities[0]!.riskFlags).not.toContain("inventory-limited");
  });

  it("uses funding signs for the perpetual leg without treating the edge as guaranteed", () => {
    const long = instrument("a:perpetual:BTCUSDT", "a", "perpetual");
    const short = instrument("b:perpetual:BTCUSDT", "b", "perpetual");
    const scope = routeScope("perpetual-perpetual-funding", long, short, 1);
    const assumptions = catalog(scope, long, short);
    assumptions.funding = [funding(long, 20), funding(short, 30)];
    const result = evaluateRouteFamilies({
      instruments: [long, short],
      books: [book(long, 99, 100), book(short, 105, 106)],
      assumptions,
      families: ["perpetual-perpetual-funding"],
      maxRoutes: 10,
      options: evaluationOptions()
    });
    expect(result.opportunities[0]!.costs.fundingNetQuote).toBeGreaterThan(0);
    expect(result.opportunities[0]!.riskFlags).toEqual(expect.arrayContaining(["funding-estimate", "convergence-assumption"]));
    expect(JSON.stringify(result)).not.toMatch(/"executable":true|"executionStatus":"guaranteed"/i);
  });

  it("rejects duplicate exact-scope assumptions rather than choosing one", () => {
    const long = instrument("a:spot:BTCUSDT", "a", "spot");
    const short = instrument("b:spot:BTCUSDT", "b", "spot");
    const scope = routeScope("cross-venue-spot-spot", long, short, 1);
    const assumptions = catalog(scope, long, short);
    assumptions.scopes = [scope, structuredClone(scope)];
    expect(() =>
      evaluateRouteFamilies({ instruments: [long, short], books: [book(long, 99, 100), book(short, 105, 106)], assumptions, families: [scope.family], options: evaluationOptions() })
    ).toThrow(/Duplicate route scope/);
  });
});

function evaluateOne(family: RouteFamily, long: PairwiseInstrument, short: PairwiseInstrument) {
  const scope = routeScope(family, long, short, 1);
  return evaluateRouteFamilies({
    instruments: [long, short],
    books: [book(long, 99, 100), book(short, 105, 106)],
    assumptions: catalog(scope, long, short),
    families: [family],
    maxRoutes: 10,
    options: evaluationOptions()
  });
}

function routeScope(family: RouteFamily, long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number): RouteFamilyScope {
  const exitAt = NOW + 7 * DAY;
  const base = { family, longInstrumentId: long.instrumentId, shortInstrumentId: short.instrumentId, requestedBaseQuantity };
  if (family === "cross-venue-spot-spot") return { ...base, rebalance: { costBps: 0, source: "verified-rebalance", asOf: NOW - 10 } };
  const convergence = { exitAt, expectedExitBasisBps: 0, longExitFeeBps: 1, shortExitFeeBps: 1, source: "stress-convergence", asOf: NOW - 10 };
  if (family === "reverse-cash-and-carry" || family === "perpetual-perpetual-funding") return { ...base, convergence };
  return { ...base, convergence, delivery: { mode: "close-before-expiry", exitAt, deliveryFeeBps: 1, source: "close-before-expiry", asOf: NOW - 10 } };
}

function catalog(scope: RouteFamilyScope, long: PairwiseInstrument, short: PairwiseInstrument): RouteFamilyAssumptionCatalog {
  const coversUntil = scope.convergence?.exitAt ?? NOW + 7 * DAY;
  return {
    scopes: [scope],
    capital: [{ instrumentId: long.instrumentId, kind: "capital", availableQuoteQuantity: 1_000_000, availabilityVerified: true, source: "verified-capital", asOf: NOW - 10 }],
    inventory: [{ instrumentId: short.instrumentId, kind: "inventory", availableBaseQuantity: 100, availabilityVerified: true, source: "verified-inventory", asOf: NOW - 10 }],
    borrow: [{ instrumentId: short.instrumentId, kind: "borrow", availableBaseQuantity: 100, annualRateBps: 0, availabilityVerified: true, coversUntil, source: "verified-borrow", asOf: NOW - 10 }],
    funding: [long, short].filter((value) => value.marketType === "perpetual").map((value) => funding(value, 0, coversUntil))
  };
}

function emptyCatalog(): RouteFamilyAssumptionCatalog {
  return { scopes: [], capital: [], inventory: [], borrow: [], funding: [] };
}

function funding(value: PairwiseInstrument, cumulativeRateBps: number, coversUntil = NOW + 7 * DAY) {
  return { instrumentId: value.instrumentId, cumulativeRateBps, coversUntil, scheduleVerified: true as const, rateKind: "venue-estimate" as const, source: "verified-funding-schedule", asOf: NOW - 10 };
}

function fixtures(): PairwiseInstrument[] {
  return [
    instrument("a:spot:BTCUSDT", "a", "spot"),
    instrument("b:spot:BTCUSDT", "b", "spot"),
    instrument("a:perpetual:BTCUSDT", "a", "perpetual"),
    instrument("b:perpetual:BTCUSDT", "b", "perpetual"),
    instrument("a:future:BTC-NEAR", "a", "future", NOW + 30 * DAY),
    instrument("a:future:BTC-FAR", "a", "future", NOW + 60 * DAY)
  ];
}

function instrument(
  instrumentId: string,
  venue: string,
  marketType: PairwiseInstrument["marketType"],
  expiryTime?: number,
  quantityModel: PairwiseInstrument["quantityModel"] = { unit: "base" }
): PairwiseInstrument {
  return {
    instrumentId,
    venue,
    symbol: instrumentId.split(":").at(-1)!,
    marketType,
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: { status: "reviewed", source: "reviewed-map", version: "2026-07-14", asOf: NOW - 100, validUntil: NOW + 30 * DAY },
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityModel,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 1,
    takerFeeBps: 1,
    ...(expiryTime === undefined ? {} : { expiryTime })
  };
}

function book(value: PairwiseInstrument, bid: number, ask: number): PairwiseBookSnapshot {
  return {
    instrumentId: value.instrumentId,
    quantityUnit: value.quantityModel.unit,
    bids: [[bid, 100]],
    asks: [[ask, 100]],
    exchangeTs: NOW - 10,
    receivedAt: NOW - 5,
    complete: true,
    sequence: 1,
    source: "fixture",
    sourceId: `fixture:${value.instrumentId}`
  };
}

function evaluationOptions() {
  return {
    evaluatedAt: NOW,
    minNetReturnBps: 0,
    maxQuoteAgeMs: 1_000,
    maxLegSkewMs: 100,
    maxFutureClockSkewMs: 100,
    maxAssumptionAgeMs: DAY,
    maxEconomicIdentityAgeMs: 30 * DAY,
    maxResidualDeltaBps: 1,
    pairingIterations: 20
  };
}
