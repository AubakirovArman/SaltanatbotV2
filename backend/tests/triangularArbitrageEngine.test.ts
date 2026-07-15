import { describe, expect, it } from "vitest";
import { TriangularArbitrageEngine, validateBookUpdate, type TriangularBookUpdate, type TriangularMarketMetadata, type TriangularOpportunity } from "../src/arbitrage/engines/triangular/index.js";

const NOW = 10_000;

describe("intra-exchange triangular arbitrage engine", () => {
  it("uses asks for quote-to-base, bids for base-to-quote, and propagates quantities", () => {
    const engine = createEngine(baseMarkets(10));
    const delta = updateAll(engine, profitableBooks());

    expect(engine.cycles).toHaveLength(2);
    expect(delta.evaluatedCycleIds).toHaveLength(2);
    expect(delta.upserted).toHaveLength(1);
    const opportunity = delta.upserted[0]!;
    expect(opportunity.legs.map((leg) => leg.side)).toEqual(["buy", "buy", "sell"]);
    expect(opportunity.legs[0].averagePrice).toBeCloseTo(100, 12);
    expect(opportunity.legs[1].averagePrice).toBeCloseTo(0.05, 12);
    expect(opportunity.legs[2].averagePrice).toBeCloseTo(5.2, 12);
    expect(opportunity.legs[1].inputQuantity).toBe(opportunity.legs[0].outputQuantity);
    expect(opportunity.legs[2].inputQuantity).toBe(opportunity.legs[1].outputQuantity);
    expect(opportunity.endQuantity).toBe(opportunity.legs[2].outputQuantity);
    expect(opportunity.grossReturnBps).toBeGreaterThan(opportunity.netReturnBps);
    expect(opportunity.netReturnBps).toBeGreaterThan(300);
    expect(opportunity.riskFlags).toContain("sequential-leg-risk");
    expect(opportunity.riskFlags).toContain("output-fee-assumption");
    expect(opportunity).toMatchObject({ edgeKind: "executable-sequential", executionStatus: "executable", marketDataMode: "sequence-verified-depth", sequenceVerified: true });
  });

  it("rejects unsequenced books in executable mode and labels REST top-book output as a non-executable candidate", () => {
    const unsequenced = profitableBooks().map(({ sequence: _sequence, ...value }) => ({ ...value, sequenceVerified: false }));
    const executable = updateAll(createEngine(baseMarkets(0)), unsequenced);
    expect(executable.upserted).toEqual([]);
    expect(executable.rejections.some((rejection) => /sequence-verified/.test(rejection.message))).toBe(true);

    const candidate = updateAll(createEngine(baseMarkets(0), { marketDataMode: "rest-top-book-candidate" }), unsequenced).upserted[0];
    expect(candidate).toMatchObject({ edgeKind: "non-executable-candidate", executionStatus: "non-executable-candidate", marketDataMode: "rest-top-book", sequenceVerified: false });
    expect(candidate?.riskFlags).toEqual(expect.arrayContaining(["top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]));
  });

  it("prebuilds cycles and reevaluates only those touched by one market edge", () => {
    const markets = [...baseMarkets(5), ...secondTriangleMarkets()];
    const engine = createEngine(markets);

    expect(engine.cycles).toHaveLength(4);
    const affected = engine.affectedCycles("BTC-USDT");
    expect(affected).toHaveLength(2);
    expect(affected.every((cycle) => cycle.edges.some((edge) => edge.marketId === "BTC-USDT"))).toBe(true);

    const delta = engine.updateBook(profitableBooks()[0]!);
    expect(delta.evaluatedCycleIds).toEqual(affected.map((cycle) => cycle.cycleId));
    expect(delta.evaluatedCycleIds).toHaveLength(2);
  });

  it("reduces the entire cycle to its limiting visible-depth capacity", () => {
    const engine = createEngine(baseMarkets(0), { startQuantities: { USDT: 1_000 } });
    const books = profitableBooks();
    books[2] = book("ETH-USDT", [[5.2, 100]], [[5.3, 500]]);
    const opportunity = updateAll(engine, books).upserted[0]!;

    expect(opportunity).toBeDefined();
    expect(opportunity.startQuantity).toBeLessThan(1_000);
    expect(opportunity.startQuantity).toBeGreaterThan(490);
    expect(opportunity.limitingCapacity.limitingLegIndex).toBe(2);
    expect(opportunity.limitingCapacity.limitingMarketId).toBe("ETH-USDT");
    expect(opportunity.limitingCapacity.utilizationPct).toBeLessThan(100);
    expect(opportunity.riskFlags).toContain("depth-limited");
    expect(opportunity.legs[2].orderBaseQuantity).toBeLessThanOrEqual(100);
  });

  it("applies lot rounding, minimum quantity/notional and reports retained dust", () => {
    const engine = createEngine(baseMarkets(10));
    const opportunity = updateAll(engine, profitableBooks()).upserted[0]!;

    expect(opportunity.legs[2].orderBaseQuantity).toBeCloseTo(199.6, 8);
    expect(opportunity.legs[2].inputDustQuantity).toBeGreaterThan(0);
    expect(opportunity.dustByAsset.ETH).toBeGreaterThan(0);
    expect(opportunity.riskFlags).toContain("rounding-dust");

    const tooSmall = createEngine(baseMarkets(0), { startQuantities: { USDT: 5 } });
    const delta = updateAll(tooSmall, profitableBooks());
    expect(delta.upserted).toEqual([]);
    expect(delta.rejections.some((rejection) => rejection.code === "minimum-quantity" || rejection.code === "minimum-notional")).toBe(true);
  });

  it("fails closed on incomplete metadata, books, stale quotes and timestamp skew", () => {
    const incompleteMetadata = baseMarkets(0);
    incompleteMetadata[1] = { ...incompleteMetadata[1]!, minimumNotional: undefined as never };
    const withoutDefaults = createEngine(incompleteMetadata);
    expect(withoutDefaults.cycles).toEqual([]);
    expect(withoutDefaults.graph.metadataRejections).toHaveLength(1);

    const partial = createEngine(baseMarkets(0));
    const partialBooks = profitableBooks();
    partialBooks[2] = { ...partialBooks[2]!, complete: false };
    const partialDelta = updateAll(partial, partialBooks);
    expect(partialDelta.upserted).toEqual([]);
    expect(partialDelta.rejections.some((rejection) => rejection.code === "incomplete-book")).toBe(true);

    const stale = createEngine(baseMarkets(0), { maxQuoteAgeMs: 500 });
    const staleBooks = profitableBooks().map((value) => ({ ...value, exchangeTs: 9_000, receivedAt: 9_000 }));
    const staleDelta = updateAll(stale, staleBooks);
    expect(staleDelta.upserted).toEqual([]);
    expect(staleDelta.rejections.some((rejection) => rejection.code === "stale-book")).toBe(true);

    const skewed = createEngine(baseMarkets(0), { maxLegSkewMs: 50 });
    const skewedBooks = profitableBooks();
    skewedBooks[0] = { ...skewedBooks[0]!, exchangeTs: 9_800, receivedAt: 9_800 };
    const skewedDelta = updateAll(skewed, skewedBooks);
    expect(skewedDelta.upserted).toEqual([]);
    expect(skewedDelta.rejections.some((rejection) => rejection.code === "skewed-books")).toBe(true);
  });

  it.each([
    { side: "bids", bids: [[99, 2], [99, 3]] as const, asks: [[100, 5], [101, 5]] as const },
    { side: "asks", bids: [[99, 5], [98, 5]] as const, asks: [[100, 2], [100, 3]] as const }
  ])("rejects adjacent duplicate $side prices instead of double-counting depth", ({ bids, asks }) => {
    const duplicate = book("BTC-USDT", bids, asks);
    expect(validateBookUpdate(duplicate, NOW, 100)).toMatch(/not strictly sorted/);
  });

  it("does not report a false profit from mid prices when executable bid/ask prices lose", () => {
    const engine = createEngine(baseMarkets(0));
    const deceptivelyProfitableMids = [book("BTC-USDT", [[99, 100]], [[101, 100]]), book("ETH-BTC", [[0.049, 5_000]], [[0.051, 5_000]]), book("ETH-USDT", [[5, 5_000]], [[5.2, 5_000]])];
    // Mid-price product is 1 / 100 / 0.05 * 5.1 = 1.02, but the executable
    // USDT->BTC->ETH->USDT direction loses after ask/ask/bid.
    const delta = updateAll(engine, deceptivelyProfitableMids);

    expect(delta.upserted).toEqual([]);
    expect(engine.opportunities()).toEqual([]);
    expect(delta.rejections.some((rejection) => rejection.code === "non-profitable")).toBe(true);
  });

  it("does not credit coarse-lot dust as cycle profit", () => {
    const markets = [market("BTC-USDT", "BTCUSDT", "BTC", "USDT", 0.1, 0, 0.1), market("ETH-BTC", "ETHBTC", "ETH", "BTC", 1, 0, 0.1), market("ETH-USDT", "ETHUSDT", "ETH", "USDT", 1, 0, 0.1)];
    const engine = createEngine(markets, { startQuantities: { USDT: 10 } });
    const grossPricesLookProfitable = [book("BTC-USDT", [[2.9, 100]], [[3, 100]]), book("ETH-BTC", [[1.9, 100]], [[2, 100]]), book("ETH-USDT", [[6.6, 100]], [[6.7, 100]])];
    // Continuous quantities imply 10% gross return, but buying only one whole
    // ETH leaves 1.3 BTC as dust. The retained BTC is exposed, not mislabelled
    // as completed-cycle USDT profit.
    const delta = updateAll(engine, grossPricesLookProfitable);

    expect(delta.upserted).toEqual([]);
    expect(engine.opportunities()).toEqual([]);
    expect(delta.rejections.some((rejection) => rejection.code === "non-profitable")).toBe(true);
  });

  it("preserves quantity conservation and lot alignment over varied inputs", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const fee = seed % 17;
      const start = 300 + seed * 17.31;
      const steps = [0.0001, 0.001, 0.01, 0.05] as const;
      const markets = baseMarkets(fee).map((market, index) => ({ ...market, quantityStep: steps[(seed + index) % steps.length]! }));
      const opportunity = soleOpportunity(createEngine(markets, { startQuantities: { USDT: start } }), profitableBooks(1 + (seed % 5) / 10_000));

      expect(opportunity.startQuantity).toBeLessThanOrEqual(start + 1e-8);
      expect(opportunity.legs[0].inputQuantity).toBeCloseTo(opportunity.startQuantity, 10);
      for (let index = 0; index < opportunity.legs.length; index += 1) {
        const leg = opportunity.legs[index]!;
        const step = markets.find((market) => market.marketId === leg.marketId)!.quantityStep;
        expect(leg.inputConsumedQuantity).toBeLessThanOrEqual(leg.inputQuantity + 1e-9);
        expect(leg.inputDustQuantity).toBeGreaterThanOrEqual(0);
        expect(leg.outputQuantity).toBeCloseTo(leg.grossOutputQuantity - leg.feeQuantity, 10);
        expect(leg.orderBaseQuantity / step).toBeCloseTo(Math.round(leg.orderBaseQuantity / step), 7);
        if (index > 0) expect(leg.inputQuantity).toBeCloseTo(opportunity.legs[index - 1]!.outputQuantity, 10);
      }
      expect(opportunity.endQuantity).toBeCloseTo(opportunity.legs[2].outputQuantity, 10);
    }
  });

  it("never improves net return when any per-leg taker fee increases", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const start = 750 + seed * 11.7;
      const returns = [0, 2, 5, 10, 20, 35].map((fee) => soleOpportunity(createEngine(baseMarkets(fee, 0.000001), { startQuantities: { USDT: start } }), profitableBooks()).netReturnBps);
      for (let index = 1; index < returns.length; index += 1) {
        expect(returns[index]!).toBeLessThanOrEqual(returns[index - 1]! + 1e-8);
      }
    }
  });

  it("expires cached opportunities when their oldest leg becomes stale", () => {
    let now = NOW;
    const engine = createEngine(baseMarkets(0), { maxQuoteAgeMs: 500, now: () => now });
    updateAll(engine, profitableBooks());
    expect(engine.opportunities()).toHaveLength(1);

    now += 501;
    expect(engine.opportunities()).toEqual([]);
  });
});

function createEngine(markets: TriangularMarketMetadata[], options: Partial<ConstructorParameters<typeof TriangularArbitrageEngine>[1]> = {}) {
  return new TriangularArbitrageEngine(markets, {
    startQuantities: { USDT: 1_000 },
    minNetReturnBps: 0,
    maxQuoteAgeMs: 1_000,
    maxLegSkewMs: 300,
    now: () => NOW,
    ...options
  });
}

function baseMarkets(feeBps: number, quantityStep = 0.01): TriangularMarketMetadata[] {
  return [market("BTC-USDT", "BTCUSDT", "BTC", "USDT", quantityStep, feeBps, 10), market("ETH-BTC", "ETHBTC", "ETH", "BTC", quantityStep, feeBps, 0.0005), market("ETH-USDT", "ETHUSDT", "ETH", "USDT", quantityStep, feeBps, 10)];
}

function secondTriangleMarkets(): TriangularMarketMetadata[] {
  return [market("XRP-USDT", "XRPUSDT", "XRP", "USDT", 0.1, 5, 10), market("SOL-XRP", "SOLXRP", "SOL", "XRP", 0.01, 5, 1), market("SOL-USDT", "SOLUSDT", "SOL", "USDT", 0.01, 5, 10)];
}

function market(marketId: string, symbol: string, baseAsset: string, quoteAsset: string, quantityStep: number, takerFeeBps: number, minimumNotional: number): TriangularMarketMetadata {
  return {
    marketId,
    venue: "testex",
    symbol,
    baseAsset,
    quoteAsset,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional,
    takerFeeBps
  };
}

function profitableBooks(extraGrossMultiplier = 1): TriangularBookUpdate[] {
  return [book("BTC-USDT", [[99.5, 1_000]], [[100, 1_000]]), book("ETH-BTC", [[0.049, 100_000]], [[0.05, 100_000]]), book("ETH-USDT", [[5.2 * extraGrossMultiplier, 100_000]], [[5.3 * extraGrossMultiplier, 100_000]])];
}

function book(marketId: string, bids: TriangularBookUpdate["bids"], asks: TriangularBookUpdate["asks"]): TriangularBookUpdate {
  return { marketId, bids, asks, exchangeTs: NOW - 10, exchangeTimestampVerified: true, receivedAt: NOW - 5, complete: true, sequence: 1, sequenceVerified: true };
}

function updateAll(engine: TriangularArbitrageEngine, books: TriangularBookUpdate[]) {
  let last: ReturnType<TriangularArbitrageEngine["updateBook"]> | undefined;
  for (const value of books) last = engine.updateBook(value);
  return last!;
}

function soleOpportunity(engine: TriangularArbitrageEngine, books: TriangularBookUpdate[]): TriangularOpportunity {
  const opportunities = updateAll(engine, books).upserted;
  expect(opportunities).toHaveLength(1);
  return opportunities[0]!;
}
