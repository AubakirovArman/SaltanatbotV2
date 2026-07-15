import { describe, expect, it } from "vitest";
import {
  N_LEG_SAFE_MAX_LEGS,
  buildNLegGraph,
  evaluateNLegCycle,
  nLegAssetUnitKey,
  type NLegAssetUnit,
  type NLegBookSnapshot,
  type NLegCycle,
  type NLegFeeSchedule,
  type NLegMarketMetadata
} from "../src/arbitrage/engines/nLeg/index.js";

const NOW = 10_000;
const VENUE = "testex";

describe("bounded N-leg arbitrage engine", () => {
  it("generates simple 4-leg cycles with deterministic rotation deduplication", () => {
    const markets = fourRing();
    const starts = [unit("USDT"), unit("A"), unit("B"), unit("C")];
    const first = buildNLegGraph(markets, { startAssets: starts, minLegs: 4, maxLegs: 4 });
    const reordered = buildNLegGraph([...markets].reverse(), { startAssets: [...starts].reverse(), minLegs: 4, maxLegs: 4 });

    expect(first.work.truncated).toBe(false);
    expect(first.cycles).toHaveLength(2);
    expect(new Set(first.cycles.map((cycle) => cycle.canonicalSignature)).size).toBe(2);
    expect(reordered.cycles.map((cycle) => cycle.cycleId)).toEqual(first.cycles.map((cycle) => cycle.cycleId));
    expect(first.cycles.every((cycle) => cycle.edges.length === 4 && new Set(cycle.edges.map((edge) => edge.instrumentId)).size === 4)).toBe(true);
  });

  it("walks multiple levels, applies every fee, and conserves exact propagated quantities", () => {
    const markets = fourRing({ inputFeeInstrumentId: "B-A", feeBps: 10, quantityStep: 0.01 });
    const graph = graphForUsdt(markets, 4);
    const cycle = forwardCycle(graph.cycles);
    const snapshots = books(graph.markets, { firstAskLevels: [[1, 40], [1.02, 1_000]], exitBid: 1.3 });
    const result = evaluateNLegCycle(request(graph.markets, cycle, snapshots, 100));

    expect(result.opportunity).toBeDefined();
    const opportunity = result.opportunity!;
    expect(opportunity).toMatchObject({ strategyKind: "n-leg-cycle", edgeKind: "research-simulation", executable: false, legCount: 4 });
    expect(opportunity.legs[0]?.levelsUsed).toBe(2);
    expect(opportunity.netReturnBps).toBeGreaterThan(1_000);
    for (const [index, leg] of opportunity.legs.entries()) {
      expect(leg.totalInputDebitedQuantity + leg.inputDustQuantity).toBeCloseTo(leg.inputQuantity, 10);
      expect(leg.outputQuantity).toBeCloseTo(leg.grossOutputQuantity - (leg.feeDebit === "output" ? leg.feeQuantity : 0), 10);
      if (index > 0) expect(leg.inputQuantity).toBeCloseTo(opportunity.legs[index - 1]!.outputQuantity, 10);
    }
    const inputFeeLeg = opportunity.legs.find((leg) => leg.instrumentId === "B-A")!;
    expect(inputFeeLeg.feeDebit).toBe("input");
    expect(inputFeeLeg.feeAssetKey).toBe(inputFeeLeg.fromKey);
    expect(inputFeeLeg.totalInputDebitedQuantity).toBeCloseTo(inputFeeLeg.tradeInputQuantity + inputFeeLeg.feeQuantity, 10);
    expect(opportunity.endQuantity).toBeCloseTo(opportunity.legs.at(-1)!.outputQuantity, 10);
  });

  it("preserves conservation and lot alignment across varied fees, steps and inputs", () => {
    const steps = [0.001, 0.01, 0.05, 0.2] as const;
    for (let seed = 1; seed <= 64; seed += 1) {
      const quantityStep = steps[seed % steps.length]!;
      const inputFeeInstrumentId = ["A-USDT", "B-A", "C-B", "C-USDT"][seed % 4];
      const markets = fourRing({ quantityStep, feeBps: seed % 31, inputFeeInstrumentId });
      const graph = graphForUsdt(markets, 4);
      const result = evaluateNLegCycle(request(graph.markets, forwardCycle(graph.cycles), books(graph.markets, { exitBid: 1.55 }), 200 + seed * 3.17));
      const opportunity = result.opportunity!;
      expect(opportunity).toBeDefined();
      expect(opportunity.startQuantity).toBeLessThanOrEqual(opportunity.requestedStartQuantity + 1e-8);
      for (const [index, leg] of opportunity.legs.entries()) {
        expect(leg.orderBaseQuantity / quantityStep).toBeCloseTo(Math.round(leg.orderBaseQuantity / quantityStep), 7);
        expect(leg.totalInputDebitedQuantity).toBeLessThanOrEqual(leg.inputQuantity + 1e-8);
        expect(leg.totalInputDebitedQuantity + leg.inputDustQuantity).toBeCloseTo(leg.inputQuantity, 9);
        expect(leg.feeAssetKey).toBe(leg.feeDebit === "input" ? leg.fromKey : leg.toKey);
        if (index > 0) expect(leg.inputQuantity).toBeCloseTo(opportunity.legs[index - 1]!.outputQuantity, 9);
      }
    }
  });

  it("tracks coarse-lot residuals instead of crediting them to cycle profit", () => {
    const markets = fourRing({ quantityStep: 0.3 });
    const graph = graphForUsdt(markets, 4);
    const cycle = forwardCycle(graph.cycles);
    const result = evaluateNLegCycle(request(graph.markets, cycle, books(graph.markets, { exitBid: 1.5 }), 10));

    expect(result.opportunity?.residuals.length).toBeGreaterThan(0);
    expect(Object.values(result.opportunity?.dustByAssetUnit ?? {}).some((quantity) => quantity > 0)).toBe(true);
    for (const residual of result.opportunity?.residuals ?? []) {
      expect(residual.quantity).toBeGreaterThan(0);
      expect(residual.assetKey).toBe(nLegAssetUnitKey(residual.asset));
    }
  });

  it("reduces the requested cycle to visible multi-leg depth capacity", () => {
    const markets = fourRing();
    const graph = graphForUsdt(markets, 4);
    const cycle = forwardCycle(graph.cycles);
    const snapshots = books(graph.markets, { firstAskLevels: [[1, 50]], exitBid: 1.3 });
    const result = evaluateNLegCycle(request(graph.markets, cycle, snapshots, 100, { maxDepthWalkSteps: 20_000 }));

    expect(result.opportunity?.depthLimited).toBe(true);
    expect(result.opportunity?.limitingLegIndex).toBe(0);
    expect(result.opportunity?.limitingInstrumentId).toBe("A-USDT");
    expect(result.opportunity?.startQuantity).toBeCloseTo(50, 6);
    expect(result.opportunity?.capacityUtilizationPct).toBeCloseTo(50, 4);
  });

  it("enforces every leg's minimum quantity and quote notional", () => {
    const quantityMarkets = fourRing().map((value) => (value.instrumentId === "B-A" ? { ...value, minimumQuantity: 200 } : value));
    const quantityGraph = graphForUsdt(quantityMarkets, 4);
    const quantityCycle = forwardCycle(quantityGraph.cycles);
    expect(evaluateNLegCycle(request(quantityGraph.markets, quantityCycle, books(quantityGraph.markets), 100)).rejection?.code).toBe("minimum-quantity");

    const notionalMarkets = fourRing().map((value) => (value.instrumentId === "C-B" ? { ...value, minimumNotional: 200 } : value));
    const notionalGraph = graphForUsdt(notionalMarkets, 4);
    const notionalCycle = forwardCycle(notionalGraph.cycles);
    expect(evaluateNLegCycle(request(notionalGraph.markets, notionalCycle, books(notionalGraph.markets), 100)).rejection?.code).toBe("minimum-notional");
  });

  it("fails closed when a fee uses an unmodelled third asset or accounting units do not connect", () => {
    const externalFee = fourRing();
    externalFee[0] = { ...externalFee[0]!, buyFee: fee(unit("FEE"), 5, "external") };
    const rejected = graphForUsdt(externalFee, 4);
    expect(rejected.cycles).toEqual([]);
    expect(rejected.metadataRejections).toContainEqual(expect.objectContaining({ instrumentId: "A-USDT", code: "fee-conservation" }));

    const disconnected = fourRing();
    disconnected[1] = {
      ...disconnected[1]!,
      quote: unit("A", "wrapped"),
      buyFee: fee(unit("B"), 0, "buy"),
      sellFee: fee(unit("A", "wrapped"), 0, "sell")
    };
    expect(graphForUsdt(disconnected, 4).cycles).toEqual([]);
  });

  it("rejects book identity mismatches, incomplete snapshots, missing sequences, staleness and skew", () => {
    const graph = graphForUsdt(fourRing(), 4);
    const cycle = forwardCycle(graph.cycles);
    const baseBooks = books(graph.markets);
    const firstId = cycle.edges[0]!.instrumentId;

    const identityBooks = new Map(baseBooks);
    identityBooks.set(firstId, { ...identityBooks.get(firstId)!, quote: unit("USDT", "cents") });
    expect(evaluateNLegCycle(request(graph.markets, cycle, identityBooks, 100)).rejection?.code).toBe("identity-mismatch");

    const incomplete = new Map(baseBooks);
    incomplete.set(firstId, { ...incomplete.get(firstId)!, complete: false });
    expect(evaluateNLegCycle(request(graph.markets, cycle, incomplete, 100)).rejection?.code).toBe("incomplete-book");

    const unsequenced = new Map(baseBooks);
    unsequenced.set(firstId, { ...unsequenced.get(firstId)!, sequenceVerified: false });
    expect(evaluateNLegCycle(request(graph.markets, cycle, unsequenced, 100)).rejection?.code).toBe("unsequenced-book");

    const stale = new Map([...baseBooks].map(([id, value]) => [id, { ...value, exchangeTs: NOW - 500, receivedAt: NOW - 500 }]));
    expect(evaluateNLegCycle(request(graph.markets, cycle, stale, 100, { maxQuoteAgeMs: 100 })).rejection?.code).toBe("stale-book");

    const skewed = new Map(baseBooks);
    skewed.set(firstId, { ...skewed.get(firstId)!, exchangeTs: NOW - 200, receivedAt: NOW - 200 });
    expect(evaluateNLegCycle(request(graph.markets, cycle, skewed, 100, { maxLegSkewMs: 50 })).rejection?.code).toBe("skewed-books");
  });

  it("supports every configurable length from four through the safe cap", () => {
    for (let legCount = 4; legCount <= N_LEG_SAFE_MAX_LEGS; legCount += 1) {
      const markets = ringMarkets(legCount);
      const graph = buildNLegGraph(markets, { startAssets: [unit("USDT")], minLegs: legCount, maxLegs: legCount });
      const cycle = graph.cycles.find(isForwardCycle)!;
      expect(cycle.edges).toHaveLength(legCount);
      expect(evaluateNLegCycle(request(graph.markets, cycle, books(graph.markets, { exitBid: 1.3 }), 100)).opportunity?.legCount).toBe(legCount);
    }
    expect(() => buildNLegGraph(fiveRing(), { startAssets: [unit("USDT")], maxLegs: N_LEG_SAFE_MAX_LEGS + 1 })).toThrow(/maxLegs/);
    expect(() => buildNLegGraph(fiveRing(), { startAssets: [unit("USDT")], minLegs: 3 })).toThrow(/minLegs/);
  });

  it("reports deterministic truncation under dense adversarial topology", () => {
    const markets = denseMarkets(7);
    const starts = Array.from({ length: 7 }, (_, index) => unit(`X${index}`));
    const options = { startAssets: starts, minLegs: 4, maxLegs: 6, maxCycles: 5, maxTraversalSteps: 100_000 } as const;
    const first = buildNLegGraph(markets, options);
    const second = buildNLegGraph([...markets].reverse(), { ...options, startAssets: [...starts].reverse() });

    expect(first.cycles).toHaveLength(5);
    expect(first.work).toMatchObject({ truncated: true, truncationReason: "cycle-limit", maxCycles: 5 });
    expect(second.cycles.map((cycle) => cycle.cycleId)).toEqual(first.cycles.map((cycle) => cycle.cycleId));

    const workLimited = buildNLegGraph(markets, { ...options, maxCycles: 100, maxTraversalSteps: 1 });
    expect(workLimited.work).toMatchObject({ traversalSteps: 1, truncated: true, truncationReason: "traversal-work-limit" });
    expect(() => buildNLegGraph(markets, { ...options, maxMarkets: markets.length - 1 })).toThrow(/exceeds maxMarkets/);
  });

  it("bounds book validation and aggregate depth walking", () => {
    const graph = graphForUsdt(fourRing(), 4);
    const cycle = forwardCycle(graph.cycles);
    const oversized = books(graph.markets);
    const firstId = cycle.edges[0]!.instrumentId;
    oversized.set(firstId, {
      ...oversized.get(firstId)!,
      bids: Array.from({ length: 6 }, (_, index) => [0.99 - index * 0.01, 100] as const),
      asks: Array.from({ length: 6 }, (_, index) => [1 + index * 0.01, 100] as const)
    });
    expect(evaluateNLegCycle(request(graph.markets, cycle, oversized, 100, { maxBookLevelsPerSide: 5 })).rejection?.code).toBe("work-limit");

    expect(evaluateNLegCycle(request(graph.markets, cycle, books(graph.markets), 100, { maxDepthWalkSteps: 1 })).rejection?.code).toBe("work-limit");
  });

  it("honors pre-aborted graph and simulation requests", () => {
    const graphAbort = new AbortController();
    graphAbort.abort(new Error("stop graph"));
    expect(() => buildNLegGraph(fourRing(), { startAssets: [unit("USDT")], signal: graphAbort.signal })).toThrow("stop graph");

    const graph = graphForUsdt(fourRing(), 4);
    const simulationAbort = new AbortController();
    simulationAbort.abort(new Error("stop simulation"));
    expect(() => evaluateNLegCycle({ ...request(graph.markets, forwardCycle(graph.cycles), books(graph.markets), 100), signal: simulationAbort.signal })).toThrow("stop simulation");
  });
});

function unit(assetId: string, unitId = "native"): NLegAssetUnit {
  return { venue: VENUE, assetId, unitId };
}

function fee(asset: NLegAssetUnit, takerBps: number, suffix: string): NLegFeeSchedule {
  return { scheduleId: `schedule-${suffix}`, tierId: "vip-0", takerBps, asset };
}

function market(instrumentId: string, baseId: string, quoteId: string, options: { quantityStep?: number; feeBps?: number; inputFee?: boolean } = {}): NLegMarketMetadata {
  const base = unit(baseId);
  const quote = unit(quoteId);
  const feeBps = options.feeBps ?? 0;
  return {
    instrumentId,
    venue: VENUE,
    symbol: instrumentId.replace("-", ""),
    marketType: "spot",
    base,
    quote,
    quantityStep: options.quantityStep ?? 0.01,
    minimumQuantity: options.quantityStep ?? 0.01,
    minimumNotional: 0.01,
    buyFee: fee(options.inputFee ? quote : base, feeBps, `${instrumentId}-buy`),
    sellFee: fee(options.inputFee ? base : quote, feeBps, `${instrumentId}-sell`)
  };
}

function fourRing(options: { quantityStep?: number; feeBps?: number; inputFeeInstrumentId?: string } = {}): NLegMarketMetadata[] {
  return [
    market("A-USDT", "A", "USDT", { ...options, inputFee: options.inputFeeInstrumentId === "A-USDT" }),
    market("B-A", "B", "A", { ...options, inputFee: options.inputFeeInstrumentId === "B-A" }),
    market("C-B", "C", "B", { ...options, inputFee: options.inputFeeInstrumentId === "C-B" }),
    market("C-USDT", "C", "USDT", { ...options, inputFee: options.inputFeeInstrumentId === "C-USDT" })
  ];
}

function fiveRing(): NLegMarketMetadata[] {
  return [market("A-USDT", "A", "USDT"), market("B-A", "B", "A"), market("C-B", "C", "B"), market("D-C", "D", "C"), market("D-USDT", "D", "USDT")];
}

function ringMarkets(legCount: number): NLegMarketMetadata[] {
  const assets = Array.from({ length: legCount - 1 }, (_, index) => `R${index + 1}`);
  const output = [market(`${assets[0]}-USDT`, assets[0]!, "USDT")];
  for (let index = 1; index < assets.length; index += 1) output.push(market(`${assets[index]}-${assets[index - 1]}`, assets[index]!, assets[index - 1]!));
  output.push(market(`${assets.at(-1)}-USDT`, assets.at(-1)!, "USDT"));
  return output;
}

function denseMarkets(assetCount: number): NLegMarketMetadata[] {
  const output: NLegMarketMetadata[] = [];
  for (let left = 0; left < assetCount; left += 1) {
    for (let right = left + 1; right < assetCount; right += 1) output.push(market(`X${left}-X${right}`, `X${left}`, `X${right}`));
  }
  return output;
}

function graphForUsdt(markets: NLegMarketMetadata[], legs: number) {
  return buildNLegGraph(markets, { startAssets: [unit("USDT")], minLegs: legs, maxLegs: legs });
}

function forwardCycle(cycles: readonly NLegCycle[]): NLegCycle {
  const cycle = cycles.find(isForwardCycle);
  if (!cycle) throw new Error("Forward test cycle is missing");
  return cycle;
}

function isForwardCycle(value: NLegCycle): boolean {
  return value.edges.every((edge, index) => edge.side === (index === value.edges.length - 1 ? "sell" : "buy"));
}

function books(
  markets: ReadonlyMap<string, NLegMarketMetadata>,
  options: { firstAskLevels?: NLegBookSnapshot["asks"]; exitBid?: number } = {}
): Map<string, NLegBookSnapshot> {
  const output = new Map<string, NLegBookSnapshot>();
  for (const market of markets.values()) {
    const entryBase = market.base.assetId === "A" || market.base.assetId === "R1";
    const exit = market.quote.assetId === "USDT" && !entryBase;
    const bids: NLegBookSnapshot["bids"] = [[exit ? (options.exitBid ?? 1.2) : 0.99, 10_000]];
    const asks: NLegBookSnapshot["asks"] = market.instrumentId === "A-USDT" && options.firstAskLevels ? options.firstAskLevels : [[exit ? (options.exitBid ?? 1.2) + 0.01 : 1, 10_000]];
    output.set(market.instrumentId, {
      instrumentId: market.instrumentId,
      base: market.base,
      quote: market.quote,
      bids,
      asks,
      exchangeTs: NOW - 10,
      exchangeTimestampVerified: true,
      receivedAt: NOW - 5,
      complete: true,
      sequence: 7,
      sequenceVerified: true,
      sourceId: `fixture:${market.instrumentId}`
    });
  }
  return output;
}

function request(
  markets: ReadonlyMap<string, NLegMarketMetadata>,
  cycle: NLegCycle,
  snapshots: ReadonlyMap<string, NLegBookSnapshot>,
  requestedStartQuantity: number,
  limits: Parameters<typeof evaluateNLegCycle>[0]["limits"] = {}
): Parameters<typeof evaluateNLegCycle>[0] {
  return { cycle, markets, books: snapshots, requestedStartQuantity, evaluatedAt: NOW, limits };
}
