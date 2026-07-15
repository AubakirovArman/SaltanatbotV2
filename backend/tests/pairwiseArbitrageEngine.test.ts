import { describe, expect, it } from "vitest";
import {
  PairwiseArbitrageEngine,
  evaluatePairwiseRoute,
  validatePairwiseBook,
  type CalendarSpreadRoute,
  type DatedFuturesSpreadRoute,
  type PairwiseBookSnapshot,
  type PairwiseEngineOptions,
  type PairwiseEvaluationOptions,
  type PairwiseInstrument,
  type PairwiseRoute,
  type PerpetualPerpetualRoute,
  type ReverseCashAndCarryRoute,
  type SpotSpotRoute
} from "../src/arbitrage/engines/pairwise/index.js";

const NOW = 1_720_000_000_000;
const DAY = 86_400_000;

describe("pairwise and carry research engine", () => {
  it("uses long asks and short bids for cross-venue spot-to-spot without reading mids", () => {
    const long = instrument("a:spot:BTCUSDT", "a", "spot", 10);
    const short = instrument("b:spot:BTCUSDT", "b", "spot", 10);
    const route = spotRoute(long, short, 5);
    const books = [book(long, [[99, 20]], [[100, 20]]), book(short, [[102, 20]], [[103, 20]])];
    const opportunity = soleOpportunity([long, short], [route], books);

    expect(opportunity.edgeKind).toBe("research-simulation");
    expect(opportunity.executable).toBe(false);
    expect(opportunity.legs.map((leg) => [leg.role, leg.side, leg.bookSide])).toEqual([
      ["long", "buy", "asks"],
      ["short", "sell", "bids"]
    ]);
    expect(opportunity.legs[0].averagePrice).toBe(100);
    expect(opportunity.legs[1].averagePrice).toBe(102);
    expect(opportunity.entryBasisBps).toBeGreaterThan(190);
    expect(opportunity.economicAssetId).toBe("crypto:bitcoin");
    expect(opportunity.provenance.economicIdentity).toMatchObject({
      economicAssetId: "crypto:bitcoin",
      matchPolicy: "exact",
      authority: "caller-supplied"
    });
    expect(opportunity.provenance.economicIdentity.legs.map((value) => value.instrumentId)).toEqual([long.instrumentId, short.instrumentId]);
    expect(opportunity.costs.entryFeesQuote).toBeCloseTo(1.01, 10);
    expect(opportunity.costs.rebalanceCostQuote).toBeGreaterThan(0);
    expect(opportunity.riskFlags).toEqual(expect.arrayContaining(["prefunded-spot-inventory", "cross-venue-rebalance", "simultaneous-execution-not-guaranteed", "caller-supplied-identity-review"]));

    const irrelevantSides = [book(long, [[1, 999]], [[100, 20]]), book(short, [[102, 20]], [[1000, 999]])];
    const same = soleOpportunity([long, short], [route], irrelevantSides);
    expect(same.netReturnBps).toBeCloseTo(opportunity.netReturnBps, 12);
  });

  it("requires exact fresh reviewed canonical economic identity instead of ticker equality", () => {
    const long = instrument("a:spot:BTCUSDT", "a", "spot", 0);
    const short = instrument("b:spot:BTCUSDT", "b", "spot", 0);
    const route = spotRoute(long, short, 1);
    const books = new Map([
      [long.instrumentId, book(long, [[99, 10]], [[100, 10]])],
      [short.instrumentId, book(short, [[104, 10]], [[105, 10]])]
    ]);
    const run = (right: PairwiseInstrument) =>
      evaluatePairwiseRoute(
        route,
        new Map([
          [long.instrumentId, long],
          [right.instrumentId, right]
        ]),
        books,
        evaluation()
      );

    expect(run({ ...short, economicAssetId: "crypto:wrapped-bitcoin" }).rejection).toMatchObject({ code: "economic-identity-mismatch" });
    const invalidCases: PairwiseInstrument[] = [
      { ...short, economicAssetId: "bitcoin" },
      { ...short, economicIdentity: undefined } as unknown as PairwiseInstrument,
      { ...short, economicIdentity: { ...short.economicIdentity, status: "unreviewed" } } as unknown as PairwiseInstrument,
      { ...short, economicIdentity: { ...short.economicIdentity, source: "" } },
      { ...short, economicIdentity: { ...short.economicIdentity, version: "" } },
      { ...short, economicIdentity: { ...short.economicIdentity, asOf: NOW - 1_001 } },
      { ...short, economicIdentity: { ...short.economicIdentity, asOf: NOW + 101, validUntil: NOW + 10_000 } }
    ];
    for (const invalid of invalidCases) {
      expect(run(invalid).rejection).toMatchObject({ code: "economic-identity-invalid", instrumentId: short.instrumentId });
    }
  });

  it("walks multiple executable depth levels and reports average and worst prices", () => {
    const long = instrument("depth:a", "a", "spot", 0);
    const short = instrument("depth:b", "b", "spot", 0);
    const opportunity = soleOpportunity(
      [long, short],
      [spotRoute(long, short, 2)],
      [
        book(
          long,
          [[99, 10]],
          [
            [100, 1],
            [101, 2]
          ]
        ),
        book(
          short,
          [
            [104, 1],
            [103, 2]
          ],
          [[105, 10]]
        )
      ]
    );

    expect(opportunity.legs[0]).toMatchObject({ levelsUsed: 2, averagePrice: 100.5, worstPrice: 101 });
    expect(opportunity.legs[1]).toMatchObject({ levelsUsed: 2, averagePrice: 103.5, worstPrice: 103 });
    expect(opportunity.grossEntryPnlQuote).toBe(6);
  });

  it("pairs base-equivalent derivative quantities through linear contract multipliers", () => {
    const long = instrument("a:perp:BTC", "a", "perpetual", 5, { unit: "contract", contractMultiplier: 0.1, multiplierAsset: "base" }, 1);
    const short = instrument("b:perp:BTC", "b", "perpetual", 5, { unit: "contract", contractMultiplier: 0.01, multiplierAsset: "base" }, 1);
    const route = perpetualRoute(long, short, 1.057);
    const opportunity = soleOpportunity([long, short], [route], [book(long, [[99, 1000]], [[100, 1000]]), book(short, [[103, 1000]], [[104, 1000]])]);

    expect(opportunity.legs[0]).toMatchObject({ nativeQuantity: 10, baseEquivalentQuantity: 1, quantityUnit: "contract" });
    expect(opportunity.legs[1]).toMatchObject({ nativeQuantity: 100, baseEquivalentQuantity: 1, quantityUnit: "contract" });
    expect(opportunity.executableBaseQuantity).toBe(1);
    expect(opportunity.baseDustQuantity).toBeCloseTo(0.057, 12);
    expect(opportunity.riskFlags).toContain("rounding-dust");
    expect(opportunity.costs.fundingNetQuote).toBeGreaterThan(0);
  });

  it("fails closed on quote-valued/inverse contracts without an explicit settlement conversion model", () => {
    const long = instrument("a:perp:inverse", "a", "perpetual", 0, { unit: "contract", contractMultiplier: 10, multiplierAsset: "quote" }, 1);
    const short = instrument("b:perp:linear", "b", "perpetual", 0, { unit: "base" }, 0.001);
    const route = perpetualRoute(long, short, 1);
    const result = evaluatePairwiseRoute(
      route,
      new Map([
        [long.instrumentId, long],
        [short.instrumentId, short]
      ]),
      new Map([
        [long.instrumentId, book(long, [[99, 100]], [[100, 10]])],
        [short.instrumentId, book(short, [[103, 10]], [[104, 10]])]
      ]),
      evaluation()
    );

    expect(result.rejection).toMatchObject({
      code: "settlement-conversion-required",
      instrumentId: long.instrumentId
    });
  });

  it("fails closed when quote or settlement assets are not a common PnL currency", () => {
    const long = instrument("a:perp:BTC", "a", "perpetual", 0);
    const short = instrument("b:perp:BTC", "b", "perpetual", 0);
    const route = perpetualRoute(long, short, 1);
    const books = new Map([
      [long.instrumentId, book(long, [[99, 10]], [[100, 10]])],
      [short.instrumentId, book(short, [[103, 10]], [[104, 10]])]
    ]);

    const differentQuote = { ...short, quoteAsset: "USDC", settleAsset: "USDC" };
    const quoteResult = evaluatePairwiseRoute(
      route,
      new Map([
        [long.instrumentId, long],
        [short.instrumentId, differentQuote]
      ]),
      books,
      evaluation()
    );
    expect(quoteResult.rejection).toMatchObject({ code: "invalid-route" });
    expect(quoteResult.rejection?.message).toMatch(/no implicit cross-asset FX conversion/);

    const inverseSettlement = { ...short, settleAsset: "BTC" };
    const settlementResult = evaluatePairwiseRoute(
      route,
      new Map([
        [long.instrumentId, long],
        [short.instrumentId, inverseSettlement]
      ]),
      books,
      evaluation()
    );
    expect(settlementResult.rejection).toMatchObject({ code: "settlement-conversion-required" });
  });

  it("requires explicit verified spot borrow for reverse cash-and-carry and charges its horizon cost", () => {
    const long = instrument("a:perp:BTC", "a", "perpetual", 5);
    const short = instrument("a:spot:BTC", "a", "spot", 5);
    const valid = reverseRoute(long, short, 2);
    const books = new Map([
      [long.instrumentId, book(long, [[98, 10]], [[99, 10]])],
      [short.instrumentId, book(short, [[103, 10]], [[104, 10]])]
    ]);
    const instruments = new Map([
      [long.instrumentId, long],
      [short.instrumentId, short]
    ]);

    const missing = { ...valid, borrow: undefined } as unknown as ReverseCashAndCarryRoute;
    expect(evaluatePairwiseRoute(missing, instruments, books, evaluation()).rejection).toMatchObject({ code: "borrow-unavailable" });
    const unverified = { ...valid, borrow: { ...valid.borrow, availabilityVerified: false } } as unknown as ReverseCashAndCarryRoute;
    expect(evaluatePairwiseRoute(unverified, instruments, books, evaluation()).rejection).toMatchObject({ code: "borrow-unavailable" });

    const result = evaluatePairwiseRoute(valid, instruments, books, evaluation());
    expect(result.opportunity).toBeDefined();
    expect(result.opportunity!.costs.borrowCostQuote).toBeGreaterThan(1.9);
    expect(result.opportunity!.costs.fundingNetQuote).toBeLessThan(0);
    expect(result.opportunity!.riskFlags).toEqual(expect.arrayContaining(["explicit-borrow-assumption", "funding-estimate"]));
  });

  it("models dated-future calendar convergence and delivery assumptions explicitly", () => {
    const far = instrument("x:future:far", "x", "future", 3, { unit: "contract", contractMultiplier: 0.1, multiplierAsset: "base" }, 1, NOW + 30 * DAY);
    const near = instrument("x:future:near", "x", "future", 3, { unit: "contract", contractMultiplier: 0.1, multiplierAsset: "base" }, 1, NOW + 10 * DAY);
    const route = calendarRoute(far, near, 1);
    const opportunity = soleOpportunity([far, near], [route], [book(far, [[99, 100]], [[100, 100]]), book(near, [[104, 100]], [[105, 100]])]);

    expect(opportunity.strategyKind).toBe("calendar-spread");
    expect(opportunity.expectedExitBasisBps).toBe(0);
    expect(opportunity.costs.deliveryFeesQuote).toBeGreaterThan(0);
    expect(opportunity.riskFlags).toEqual(expect.arrayContaining(["delivery-assumption", "derivative-margin-not-modeled"]));

    const badRoute = { ...route, delivery: { ...route.delivery, nearInstrumentId: far.instrumentId } } as CalendarSpreadRoute;
    const failed = evaluatePairwiseRoute(
      badRoute,
      new Map([
        [far.instrumentId, far],
        [near.instrumentId, near]
      ]),
      new Map([
        [far.instrumentId, book(far, [[99, 100]], [[100, 100]])],
        [near.instrumentId, book(near, [[104, 100]], [[105, 100]])]
      ]),
      evaluation()
    );
    expect(failed.rejection).toMatchObject({ code: "expiry-boundary" });
  });

  it("supports same-expiry dated futures across venues only with close-before-delivery", () => {
    const expiry = NOW + 20 * DAY;
    const long = instrument("a:future:quarter", "a", "future", 2, { unit: "contract", contractMultiplier: 0.1, multiplierAsset: "base" }, 1, expiry);
    const short = instrument("b:future:quarter", "b", "future", 2, { unit: "contract", contractMultiplier: 0.1, multiplierAsset: "base" }, 1, expiry);
    const route = datedFuturesRoute(long, short, 1);
    const opportunity = soleOpportunity([long, short], [route], [book(long, [[99, 100]], [[100, 100]]), book(short, [[103, 100]], [[104, 100]])]);

    expect(opportunity.strategyKind).toBe("dated-futures-spread");
    expect(opportunity.costs.deliveryFeesQuote).toBeGreaterThan(0);
    expect(opportunity.timestamps.horizonExitAt).toBe(NOW + 10 * DAY);

    const settlement = {
      ...route,
      delivery: {
        mode: "settle-near-roll-far",
        exitAt: expiry,
        nearInstrumentId: long.instrumentId,
        deliveryFeeBps: 2,
        settlementPriceSource: "index",
        source: "invalid-same-expiry-settlement",
        asOf: NOW - 10
      },
      convergence: { ...route.convergence, exitAt: expiry }
    } as DatedFuturesSpreadRoute;
    const result = evaluatePairwiseRoute(
      settlement,
      new Map([
        [long.instrumentId, long],
        [short.instrumentId, short]
      ]),
      new Map([
        [long.instrumentId, book(long, [[99, 100]], [[100, 100]])],
        [short.instrumentId, book(short, [[103, 100]], [[104, 100]])]
      ]),
      evaluation()
    );
    expect(result.rejection).toMatchObject({ code: "expiry-boundary" });
  });

  it("reduces both legs to visible depth and explicit inventory without crediting dust", () => {
    const long = instrument("a:spot:BTC", "a", "spot", 0);
    const short = instrument("b:spot:BTC", "b", "spot", 0);
    const route = { ...spotRoute(long, short, 10), shortAccess: { ...spotRoute(long, short, 10).shortAccess, availableBaseQuantity: 4 } };
    const opportunity = soleOpportunity([long, short], [route], [book(long, [[99, 20]], [[100, 3]]), book(short, [[102, 20]], [[103, 20]])]);

    expect(opportunity.executableBaseQuantity).toBe(3);
    expect(opportunity.unfilledBaseQuantity).toBe(7);
    expect(opportunity.capacityShortfallBaseQuantity).toBe(7);
    expect(opportunity.baseDustQuantity).toBe(0);
    expect(opportunity.netExpectedPnlQuote).toBeLessThan(opportunity.grossExpectedPnlQuote);
    expect(opportunity.riskFlags).toEqual(expect.arrayContaining(["depth-limited", "inventory-limited"]));
    expect(opportunity.riskFlags).not.toContain("rounding-dust");
  });

  it("fails closed on incomplete, stale, skewed, crossed and unit-mismatched books", () => {
    const long = instrument("a:spot:BTC", "a", "spot", 0);
    const short = instrument("b:spot:BTC", "b", "spot", 0);
    const route = spotRoute(long, short, 1);
    const instruments = new Map([
      [long.instrumentId, long],
      [short.instrumentId, short]
    ]);
    const validLong = book(long, [[99, 10]], [[100, 10]]);
    const validShort = book(short, [[102, 10]], [[103, 10]]);

    const cases: Array<[PairwiseBookSnapshot, PairwiseBookSnapshot, string]> = [
      [{ ...validLong, complete: false }, validShort, "incomplete-book"],
      [{ ...validLong, exchangeTs: NOW - 2_000, receivedAt: NOW - 2_000 }, validShort, "stale-book"],
      [{ ...validLong, exchangeTs: NOW - 500, receivedAt: NOW - 500 }, validShort, "skewed-books"],
      [{ ...validLong, bids: [[101, 1]] }, validShort, "invalid-book"],
      [{ ...validLong, quantityUnit: "quote" }, validShort, "invalid-book"]
    ];
    for (const [left, right, code] of cases) {
      const result = evaluatePairwiseRoute(
        route,
        instruments,
        new Map([
          [long.instrumentId, left],
          [short.instrumentId, right]
        ]),
        evaluation()
      );
      expect(result.rejection?.code).toBe(code);
    }
  });

  it.each([
    { side: "bids", bids: [[99, 2], [99, 3]] as const, asks: [[100, 5], [101, 5]] as const },
    { side: "asks", bids: [[99, 5], [98, 5]] as const, asks: [[100, 2], [100, 3]] as const }
  ])("rejects adjacent duplicate $side prices instead of double-counting depth", ({ bids, asks }) => {
    const value = instrument("duplicate:spot:BTC", "a", "spot", 0);
    expect(validatePairwiseBook(book(value, bids, asks), value, NOW, 100)).toMatch(/not strictly sorted/);
  });

  it("rejects stale or missing carry assumptions and post-rounding minimum violations", () => {
    const spotLong = instrument("assume:a", "a", "spot", 0);
    const spotShort = instrument("assume:b", "b", "spot", 0);
    const staleInventory = {
      ...spotRoute(spotLong, spotShort, 1),
      shortAccess: { ...spotRoute(spotLong, spotShort, 1).shortAccess, asOf: NOW - 2_000 }
    };
    const spotResult = evaluatePairwiseRoute(
      staleInventory,
      new Map([
        [spotLong.instrumentId, spotLong],
        [spotShort.instrumentId, spotShort]
      ]),
      new Map([
        [spotLong.instrumentId, book(spotLong, [[99, 10]], [[100, 10]])],
        [spotShort.instrumentId, book(spotShort, [[104, 10]], [[105, 10]])]
      ]),
      evaluation()
    );
    expect(spotResult.rejection).toMatchObject({ code: "stale-assumption" });

    const perpLong = instrument("assume:perp:a", "a", "perpetual", 0);
    const perpShort = instrument("assume:perp:b", "b", "perpetual", 0);
    const missingFunding = { ...perpetualRoute(perpLong, perpShort, 1), funding: [] };
    const perpResult = evaluatePairwiseRoute(
      missingFunding,
      new Map([
        [perpLong.instrumentId, perpLong],
        [perpShort.instrumentId, perpShort]
      ]),
      new Map([
        [perpLong.instrumentId, book(perpLong, [[99, 10]], [[100, 10]])],
        [perpShort.instrumentId, book(perpShort, [[104, 10]], [[105, 10]])]
      ]),
      evaluation()
    );
    expect(perpResult.rejection).toMatchObject({ code: "missing-assumption" });

    const coarseLong = { ...spotLong, quantityStep: 1, minimumQuantity: 1, minimumNotional: 1 };
    const coarseShort = { ...spotShort, quantityStep: 1, minimumQuantity: 1, minimumNotional: 1 };
    const minimumResult = evaluatePairwiseRoute(
      spotRoute(coarseLong, coarseShort, 0.5),
      new Map([
        [coarseLong.instrumentId, coarseLong],
        [coarseShort.instrumentId, coarseShort]
      ]),
      new Map([
        [coarseLong.instrumentId, book(coarseLong, [[99, 10]], [[100, 10]])],
        [coarseShort.instrumentId, book(coarseShort, [[104, 10]], [[105, 10]])]
      ]),
      evaluation()
    );
    expect(minimumResult.rejection).toMatchObject({ code: "minimum-quantity" });

    const highMinimumLong = { ...spotLong, minimumNotional: 1_000 };
    const highMinimumShort = { ...spotShort, minimumNotional: 1_000 };
    const notionalResult = evaluatePairwiseRoute(
      spotRoute(highMinimumLong, highMinimumShort, 1),
      new Map([
        [highMinimumLong.instrumentId, highMinimumLong],
        [highMinimumShort.instrumentId, highMinimumShort]
      ]),
      new Map([
        [highMinimumLong.instrumentId, book(highMinimumLong, [[99, 10]], [[100, 10]])],
        [highMinimumShort.instrumentId, book(highMinimumShort, [[104, 10]], [[105, 10]])]
      ]),
      evaluation()
    );
    expect(notionalResult.rejection).toMatchObject({ code: "minimum-notional" });
  });

  it("keeps quantity/step invariants and never improves return when explicit fees rise", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const step = [0.0001, 0.001, 0.01, 0.05][seed % 4]!;
      const request = 1 + seed * 0.0713;
      const long = instrument(`a:${seed}`, "a", "spot", seed % 9, { unit: "base" }, step);
      const short = instrument(`b:${seed}`, "b", "spot", seed % 7, { unit: "base" }, step * 2);
      const route = spotRoute(long, short, request);
      const opportunity = soleOpportunity([long, short], [route], [book(long, [[99, 100]], [[100, 100]]), book(short, [[104, 100]], [[105, 100]])]);
      expect(opportunity.executableBaseQuantity).toBeLessThanOrEqual(request + 1e-9);
      for (const [index, leg] of opportunity.legs.entries()) {
        const legStep = index === 0 ? step : step * 2;
        expect(leg.nativeQuantity / legStep).toBeCloseTo(Math.round(leg.nativeQuantity / legStep), 8);
        expect(leg.baseEquivalentQuantity).toBeGreaterThan(0);
      }
      expect((Math.abs(opportunity.residualBaseQuantity) / opportunity.executableBaseQuantity) * 10_000).toBeLessThanOrEqual(1 + 1e-8);
    }

    const long = instrument("fee:a", "a", "spot", 0);
    const short = instrument("fee:b", "b", "spot", 0);
    const returns = [0, 2, 5, 10, 25, 50].map((fee) => {
      const left = { ...long, takerFeeBps: fee };
      const right = { ...short, takerFeeBps: fee };
      return soleOpportunity([left, right], [spotRoute(left, right, 2)], [book(left, [[99, 10]], [[100, 10]]), book(right, [[104, 10]], [[105, 10]])]).netReturnBps;
    });
    for (let index = 1; index < returns.length; index += 1) expect(returns[index]!).toBeLessThan(returns[index - 1]!);
  });

  it("ranks deterministically, expires stale results and exposes exact route provenance", () => {
    let now = NOW;
    const long = instrument("rank:a", "a", "spot", 0);
    const short = instrument("rank:b", "b", "spot", 0);
    const cheap = { ...spotRoute(long, short, 2, "z-cheap"), rebalance: assumptionRebalance(0) };
    const costly = { ...spotRoute(long, short, 2, "a-costly"), rebalance: assumptionRebalance(20) };
    const engine = createEngine([long, short], [costly, cheap], { now: () => now, maxQuoteAgeMs: 100 });
    engine.updateBook(book(long, [[99, 10]], [[100, 10]]));
    const delta = engine.updateBook(book(short, [[104, 10]], [[105, 10]]));

    expect(delta.evaluatedRouteIds).toEqual(["a-costly", "z-cheap"]);
    expect(delta.upserted.map((value) => value.routeId)).toEqual(["z-cheap", "a-costly"]);
    expect(delta.upserted[0]!.provenance.assumptions.map((value) => value.kind)).toEqual(["capital", "inventory", "rebalance"]);
    expect(engine.affectedRoutes(long.instrumentId).map((value) => value.routeId)).toEqual(["a-costly", "z-cheap"]);
    now += 101;
    expect(engine.opportunities()).toEqual([]);
  });

  it("expires cached research at the deterministic economic-identity boundary", () => {
    let now = NOW;
    const baseLong = instrument("identity-expiry:a", "a", "spot", 0);
    const baseShort = instrument("identity-expiry:b", "b", "spot", 0);
    const long = { ...baseLong, economicIdentity: { ...baseLong.economicIdentity, validUntil: NOW + 50 } };
    const short = { ...baseShort, economicIdentity: { ...baseShort.economicIdentity, validUntil: NOW + 50 } };
    const engine = createEngine([long, short], [spotRoute(long, short, 1)], {
      now: () => now,
      maxQuoteAgeMs: 1_000,
      maxAssumptionAgeMs: 1_000,
      maxEconomicIdentityAgeMs: 1_000
    });
    engine.updateBook(book(long, [[99, 10]], [[100, 10]]));
    expect(engine.updateBook(book(short, [[104, 10]], [[105, 10]])).upserted).toHaveLength(1);
    now += 51;
    expect(engine.opportunities()).toEqual([]);
  });

  it("reevaluates hundreds of configured pairs within a bounded performance sanity budget", () => {
    const long = instrument("perf:a", "a", "spot", 0);
    const short = instrument("perf:b", "b", "spot", 0);
    const routes = Array.from({ length: 750 }, (_, index) => spotRoute(long, short, 2, `route-${String(index).padStart(4, "0")}`));
    const engine = createEngine([long, short], routes);
    engine.updateBook(book(long, [[99, 1000]], [[100, 1000]]));
    const started = performance.now();
    const delta = engine.updateBook(book(short, [[104, 1000]], [[105, 1000]]));
    const elapsed = performance.now() - started;

    expect(delta.evaluatedRouteIds).toHaveLength(750);
    expect(delta.upserted).toHaveLength(750);
    expect(elapsed).toBeLessThan(2_000);
  });
});

function instrument(instrumentId: string, venue: string, marketType: PairwiseInstrument["marketType"], takerFeeBps: number, quantityModel: PairwiseInstrument["quantityModel"] = { unit: "base" }, quantityStep = 0.001, expiryTime?: number): PairwiseInstrument {
  return {
    instrumentId,
    venue,
    symbol: instrumentId.split(":").at(-1) ?? instrumentId,
    marketType,
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: {
      status: "reviewed",
      source: "test-reviewed-asset-map",
      version: "2026-07-14",
      asOf: NOW - 10,
      validUntil: NOW + 30 * DAY
    },
    quoteAsset: "USDT",
    settleAsset: marketType === "spot" ? "USDT" : "USDT",
    quantityModel,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional: 1,
    takerFeeBps,
    ...(expiryTime ? { expiryTime } : {})
  };
}

function book(instrument: PairwiseInstrument, bids: PairwiseBookSnapshot["bids"], asks: PairwiseBookSnapshot["asks"]): PairwiseBookSnapshot {
  return {
    instrumentId: instrument.instrumentId,
    quantityUnit: instrument.quantityModel.unit,
    bids,
    asks,
    exchangeTs: NOW - 10,
    receivedAt: NOW - 5,
    complete: true,
    sequence: 1,
    source: "fixture",
    sourceId: `fixture:${instrument.instrumentId}`
  };
}

function spotRoute(long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number, routeId = "spot-route"): SpotSpotRoute {
  return {
    routeId,
    strategyKind: "spot-spot",
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    requestedBaseQuantity,
    longCapital: { kind: "capital", availableQuoteQuantity: requestedBaseQuantity * 1_000_000, availabilityVerified: true, source: "operator-fixture", asOf: NOW - 10 },
    shortAccess: { kind: "inventory", availableBaseQuantity: requestedBaseQuantity, availabilityVerified: true, source: "operator-fixture", asOf: NOW - 10 },
    rebalance: assumptionRebalance(5)
  };
}

function perpetualRoute(long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number): PerpetualPerpetualRoute {
  const convergence = assumptionConvergence(NOW + 7 * DAY);
  return {
    routeId: "perpetual-route",
    strategyKind: "perpetual-perpetual",
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    requestedBaseQuantity,
    convergence,
    funding: [funding(long, 10, convergence.exitAt), funding(short, 20, convergence.exitAt)]
  };
}

function reverseRoute(long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number): ReverseCashAndCarryRoute {
  const convergence = assumptionConvergence(NOW + 10 * DAY);
  return {
    routeId: "reverse-route",
    strategyKind: "reverse-cash-and-carry",
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    requestedBaseQuantity,
    convergence,
    borrow: {
      kind: "borrow",
      availableBaseQuantity: requestedBaseQuantity,
      annualRateBps: 3_650,
      availabilityVerified: true,
      coversUntil: convergence.exitAt,
      source: "verified-borrow-fixture",
      asOf: NOW - 10
    },
    funding: [funding(long, 5, convergence.exitAt)]
  };
}

function calendarRoute(long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number): CalendarSpreadRoute {
  const near = long.expiryTime! < short.expiryTime! ? long : short;
  const convergence = assumptionConvergence(near.expiryTime!);
  return {
    routeId: "calendar-route",
    strategyKind: "calendar-spread",
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    requestedBaseQuantity,
    convergence,
    delivery: {
      mode: "settle-near-roll-far",
      exitAt: convergence.exitAt,
      nearInstrumentId: near.instrumentId,
      deliveryFeeBps: 2,
      settlementPriceSource: "venue-settlement-index",
      source: "calendar-fixture",
      asOf: NOW - 10
    }
  };
}

function datedFuturesRoute(long: PairwiseInstrument, short: PairwiseInstrument, requestedBaseQuantity: number): DatedFuturesSpreadRoute {
  const convergence = assumptionConvergence(NOW + 10 * DAY);
  return {
    routeId: "dated-futures-route",
    strategyKind: "dated-futures-spread",
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    requestedBaseQuantity,
    convergence,
    delivery: {
      mode: "close-before-expiry",
      exitAt: convergence.exitAt,
      deliveryFeeBps: 1,
      source: "dated-futures-fixture",
      asOf: NOW - 10
    }
  };
}

function assumptionConvergence(exitAt: number) {
  return { exitAt, expectedExitBasisBps: 0, longExitFeeBps: 5, shortExitFeeBps: 5, source: "stress-fixture", asOf: NOW - 10 };
}

function assumptionRebalance(costBps: number) {
  return { costBps, source: "rebalance-fixture", asOf: NOW - 10 };
}

function funding(instrument: PairwiseInstrument, cumulativeRateBps: number, coversUntil: number) {
  return {
    instrumentId: instrument.instrumentId,
    cumulativeRateBps,
    coversUntil,
    scheduleVerified: true as const,
    rateKind: "venue-estimate" as const,
    source: "funding-fixture",
    asOf: NOW - 10
  };
}

function evaluation(overrides: Partial<PairwiseEvaluationOptions> = {}): PairwiseEvaluationOptions {
  return {
    evaluatedAt: NOW,
    minNetReturnBps: 0,
    maxQuoteAgeMs: 1_000,
    maxLegSkewMs: 100,
    maxFutureClockSkewMs: 100,
    maxAssumptionAgeMs: 1_000,
    maxEconomicIdentityAgeMs: 1_000,
    maxResidualDeltaBps: 1,
    pairingIterations: 20,
    ...overrides
  };
}

function createEngine(instruments: PairwiseInstrument[], routes: PairwiseRoute[], overrides: PairwiseEngineOptions = {}) {
  return new PairwiseArbitrageEngine(instruments, routes, {
    now: () => NOW,
    minNetReturnBps: 0,
    maxQuoteAgeMs: 1_000,
    maxLegSkewMs: 100,
    maxAssumptionAgeMs: 1_000,
    maxEconomicIdentityAgeMs: 1_000,
    maxResidualDeltaBps: 1,
    ...overrides
  });
}

function soleOpportunity(instruments: PairwiseInstrument[], routes: PairwiseRoute[], books: PairwiseBookSnapshot[]) {
  const engine = createEngine(instruments, routes);
  let last: ReturnType<PairwiseArbitrageEngine["updateBook"]> | undefined;
  for (const value of books) last = engine.updateBook(value);
  expect(last?.upserted).toHaveLength(1);
  return last!.upserted[0]!;
}
