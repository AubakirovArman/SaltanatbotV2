import { describe, expect, it } from "vitest";
import { buildNLegGraph, type NLegAssetUnit, type NLegMarketMetadata } from "../src/arbitrage/engines/nLeg/index.js";
import type { OptionsParityAssumptions, OptionsParityInstrument } from "../src/arbitrage/engines/optionsParity/index.js";
import type { PairwiseInstrument, PairwiseRoute, SpotSpotRoute } from "../src/arbitrage/engines/pairwise/index.js";
import type { TriangularMarketMetadata } from "../src/arbitrage/engines/triangular/index.js";
import type { NativeSpreadInstrument } from "../src/arbitrage/nativeSpreads/index.js";
import {
  createEngineReplayManifest,
  createReplayManifest,
  replayNLegEvaluation,
  replayNativeSpreadEvaluation,
  replayOptionsParityEvaluation,
  replayPairwiseEvaluation,
  replayTriangularEvaluation,
  type NLegReplayInput,
  type OptionsParityReplayInput,
  type PairwiseReplayInput,
  type ReplayDataset,
  type ReplayEvent,
  type TriangularReplayInput
} from "../src/arbitrage/replay/index.js";

const NOW = 1_784_000_000_000;
const DAY = 86_400_000;
const DIGEST = `sha256:${"a".repeat(64)}` as const;

describe("immutable multi-engine point-in-time replay", () => {
  it("replays triangular depth deterministically with manifest and output digests", () => {
    const markets = triangularMarkets();
    const dataset = datasetFor(markets.map((market, index) => spec(market.marketId, market.venue, market.symbol, "spot", market.quantityStep, market.minimumQuantity, market.minimumNotional, triangularDepth(index))));
    const input: TriangularReplayInput = {
      markets,
      startQuantities: { USDT: 1_000 },
      minNetReturnBps: 0,
      maxQuoteAgeMs: 1_000,
      maxLegSkewMs: 100,
      maxFutureClockSkewMs: 100,
      depthSearchIterations: 32
    };
    const manifest = engineManifest(dataset, "triangular", input);
    const first = replayTriangularEvaluation(dataset, manifest, input);
    const second = replayTriangularEvaluation(dataset, manifest, structuredClone(input));

    expect(first).toMatchObject({ engine: "triangular", engineVersion: "triangular-v1", verifiedPointInTime: true, readOnly: true, executable: false });
    expect(first.output.opportunities).toHaveLength(1);
    expect(first.output.opportunities[0]).toMatchObject({ sequenceVerified: true, executionStatus: "executable" });
    expect(first.outputDigest).toBe(second.outputDigest);
    expect(first.manifestDigest).toBe(second.manifestDigest);
  });

  it("replays pairwise route families with immutable assumptions and registry bindings", () => {
    const instruments = pairwiseInstruments();
    const dataset = datasetFor([
      spec(instruments[0]!.instrumentId, "a", instruments[0]!.symbol, "spot", 0.001, 0.001, 1, { bids: [[99, 10]], asks: [[100, 10]] }, "crypto:bitcoin"),
      spec(instruments[1]!.instrumentId, "b", instruments[1]!.symbol, "spot", 0.001, 0.001, 1, { bids: [[104, 10]], asks: [[105, 10]] }, "crypto:bitcoin")
    ]);
    const route: SpotSpotRoute = {
      routeId: "spot-spread",
      strategyKind: "spot-spot",
      longInstrumentId: instruments[0]!.instrumentId,
      shortInstrumentId: instruments[1]!.instrumentId,
      requestedBaseQuantity: 1,
      longCapital: { kind: "capital", availableQuoteQuantity: 1_000, availabilityVerified: true, source: "fixture-capital", asOf: NOW - 100 },
      shortAccess: { kind: "inventory", availableBaseQuantity: 1, availabilityVerified: true, source: "fixture-inventory", asOf: NOW - 100 },
      rebalance: { costBps: 2, source: "fixture-transfer", asOf: NOW - 100 }
    };
    const input: PairwiseReplayInput = {
      instruments,
      routes: [route],
      evaluation: {
        minNetReturnBps: 0,
        maxQuoteAgeMs: 1_000,
        maxLegSkewMs: 100,
        maxFutureClockSkewMs: 100,
        maxAssumptionAgeMs: 1_000,
        maxEconomicIdentityAgeMs: 1_000,
        maxResidualDeltaBps: 1,
        pairingIterations: 20
      }
    };
    const result = replayPairwiseEvaluation(dataset, engineManifest(dataset, "pairwise", input), input);

    expect(result.output.routeCount).toBe(1);
    expect(result.output.opportunities[0]).toMatchObject({ strategyKind: "spot-spot", edgeKind: "research-simulation", executable: false });
    expect(result.output.opportunities[0]?.provenance.books.map((book) => book.sourceId)).toEqual(expect.arrayContaining(["depth:0", "depth:1"]));
  });

  it("covers every current pairwise route kind through the same replay boundary", () => {
    for (const family of pairwiseFamilyCases()) {
      const dataset = datasetFor(
        family.instruments.map((instrument, index) =>
          spec(instrument.instrumentId, instrument.venue, instrument.symbol, instrument.marketType, instrument.quantityStep, instrument.minimumQuantity, instrument.minimumNotional, index === 0 ? { bids: [[99, 10]], asks: [[100, 10]] } : { bids: [[104, 10]], asks: [[105, 10]] }, "crypto:bitcoin")
        )
      );
      const input = pairwiseReplayInput(family.instruments, family.route);
      const result = replayPairwiseEvaluation(dataset, engineManifest(dataset, "pairwise", input), input);
      expect(result.output.opportunities, family.route.strategyKind).toHaveLength(1);
      expect(result.output.opportunities[0]?.strategyKind).toBe(family.route.strategyKind);
    }
  });

  it("replays a bounded four-leg conserved-quantity cycle", () => {
    const markets = nLegMarkets();
    const graph = buildNLegGraph(markets, { startAssets: [unit("USDT")], minLegs: 4, maxLegs: 4 });
    const cycle = graph.cycles.find((candidate) => candidate.edges.every((edge, index) => edge.side === (index === 3 ? "sell" : "buy")))!;
    const dataset = datasetFor(markets.map((market, index) => spec(market.instrumentId, market.venue, market.symbol, "spot", market.quantityStep, market.minimumQuantity, market.minimumNotional, { bids: [[index === 3 ? 1.3 : 0.99, 10_000]], asks: [[index === 3 ? 1.31 : 1, 10_000]] })));
    const input: NLegReplayInput = { cycle, markets, requestedStartQuantity: 100, limits: { maxQuoteAgeMs: 1_000, maxLegSkewMs: 100 } };
    const result = replayNLegEvaluation(dataset, engineManifest(dataset, "n-leg", input), input);

    expect(result.output.opportunity).toMatchObject({ strategyKind: "n-leg-cycle", legCount: 4, executable: false });
    expect(result.output.opportunity?.provenance.bookSourceIds).toEqual(["depth:0", "depth:1", "depth:2", "depth:3"]);
  });

  it("replays options parity with point-in-time books and assumption provenance", () => {
    const call = option("btc-100-C", "call");
    const put = option("btc-100-P", "put");
    const dataset = datasetFor([
      spec(call.instrumentId, "fixture", call.instrumentId, "option", 0.1, 0.1, 1, { bids: [[12, 5]], asks: [[13, 5]] }, "crypto:bitcoin"),
      spec(put.instrumentId, "fixture", put.instrumentId, "option", 0.1, 0.1, 1, { bids: [[1, 5]], asks: [[2, 5]] }, "crypto:bitcoin"),
      spec("BTC-USDC", "fixture", "BTC-USDC", "spot", 0.1, 0.1, 1, { bids: [[99, 10]], asks: [[100, 10]] }, "crypto:bitcoin")
    ]);
    const input: OptionsParityReplayInput = {
      primary: { seriesId: "btc-100", call, put },
      underlying: {
        instrumentId: "BTC-USDC",
        venue: "fixture",
        baseAsset: "BTC",
        quoteAsset: "USDC",
        quantityUnit: "base",
        basePerQuantityUnit: 1,
        quantityStep: 0.1,
        minimumQuantity: 0.1
      },
      targetBaseQuantity: 1,
      assumptions: optionAssumptions([call, put]),
      limits: { maxQuoteAgeMs: 1_000, maxLegSkewMs: 100, maxAssumptionAgeMs: 1_000 }
    };
    const result = replayOptionsParityEvaluation(dataset, engineManifest(dataset, "options-parity", input), input);

    expect(result.output.candidates.map((candidate) => candidate.strategyKind)).toEqual(expect.arrayContaining(["put-call-parity", "conversion", "synthetic-forward"]));
    expect(result.output.candidates.every((candidate) => candidate.executable === false)).toBe(true);
  });

  it("replays a venue-native spread without converting it into an executable order", () => {
    const instrument = nativeInstrument();
    const dataset = datasetFor([spec(instrument.symbol, "bybit", instrument.symbol, "native-spread", 0.01, 0.01, 1, { bids: [[-2, 3]], asks: [[-1, 4]], matchingEngineTs: NOW - 60 })]);
    const input = { instrument, minimumQuantity: 1, maxQuoteAgeMs: 1_000, maxFutureClockSkewMs: 100 };
    const result = replayNativeSpreadEvaluation(dataset, engineManifest(dataset, "native-spread", input), input);

    expect(result).toMatchObject({ readOnly: true, executable: false });
    expect(result.output.opportunity).toMatchObject({ venue: "bybit", executableQuantity: 3, sequence: 10_000, matchingEngineTs: NOW - 60 });
    expect(result.output.opportunity?.riskFlags).toContain("historical-not-executable");
  });

  it("fails closed on missing, duplicate, late, stale-selected, reordered and mutated evidence", () => {
    const markets = triangularMarkets();
    const specs = markets.map((market, index) => spec(market.marketId, market.venue, market.symbol, "spot", market.quantityStep, market.minimumQuantity, market.minimumNotional, triangularDepth(index)));
    const dataset = datasetFor(specs);
    const input: TriangularReplayInput = {
      markets,
      startQuantities: { USDT: 1_000 },
      minNetReturnBps: 0,
      maxQuoteAgeMs: 1_000,
      maxLegSkewMs: 100,
      maxFutureClockSkewMs: 100,
      depthSearchIterations: 32
    };
    const indexes = depthIndexes(dataset);

    const missing = createEngineReplayManifest(dataset, { evaluationId: "triangular-proof", engine: "triangular", evaluatedAt: NOW, input, evidenceEventIndexes: indexes.slice(0, 2) });
    expect(() => replayTriangularEvaluation(dataset, missing, input)).toThrow(/exactly cover required instruments/);
    expect(() => createEngineReplayManifest(dataset, { evaluationId: "duplicate", engine: "triangular", evaluatedAt: NOW, input, evidenceEventIndexes: [indexes[0]!, indexes[0]!] })).toThrow(/duplicate evidence/);

    const valid = engineManifest(dataset, "triangular", input);
    expect(() => replayTriangularEvaluation(dataset, valid, { ...input, minNetReturnBps: 1 })).toThrow(/input digest mismatch/);
    expect(() => createEngineReplayManifest(dataset, { evaluationId: "secret", engine: "triangular", evaluatedAt: NOW, input: { ...input, apiKey: "forbidden" }, evidenceEventIndexes: indexes })).toThrow(/forbidden/);

    const late = structuredClone(dataset);
    late.events[indexes[0]!]!.receivedAt = NOW + 1;
    late.events.sort(compareEvents);
    late.manifest = createReplayManifest(manifestInput(), late.events);
    expect(() => createEngineReplayManifest(late, { evaluationId: "late", engine: "triangular", evaluatedAt: NOW, input, evidenceEventIndexes: depthIndexes(late) })).toThrow(/arrived after/);

    const newer = structuredClone(dataset);
    newer.events.push({ ...structuredClone(newer.events[indexes[0]!]!), sequence: 2, receivedAt: NOW - 1, exchangeTs: NOW - 2 });
    newer.events.sort(compareEvents);
    newer.manifest = createReplayManifest(manifestInput(), newer.events);
    expect(() => createEngineReplayManifest(newer, { evaluationId: "selected-old", engine: "triangular", evaluatedAt: NOW, input, evidenceEventIndexes: depthIndexes(newer).filter((index) => newer.events[index]!.sequence === 1) })).toThrow(/not the latest depth/);

    const reordered = structuredClone(dataset);
    [reordered.events[indexes[0]!], reordered.events[indexes[1]!]] = [reordered.events[indexes[1]!]!, reordered.events[indexes[0]!]!];
    reordered.manifest = createReplayManifest(manifestInput(), reordered.events);
    expect(() => createEngineReplayManifest(reordered, { evaluationId: "reordered", engine: "triangular", evaluatedAt: NOW, input, evidenceEventIndexes: indexes })).toThrow(/canonical order/);
  });
});

interface InstrumentSpec {
  id: string;
  venue: string;
  symbol: string;
  marketType: string;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  economicAssetId: string;
  depth: { bids: number[][]; asks: number[][]; matchingEngineTs?: number };
}

function spec(id: string, venue: string, symbol: string, marketType: string, quantityStep: number, minimumQuantity: number, minimumNotional: number, depth: InstrumentSpec["depth"], economicAssetId = `instrument:${id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`): InstrumentSpec {
  return { id, venue, symbol, marketType, quantityStep, minimumQuantity, minimumNotional, economicAssetId, depth };
}

function datasetFor(specs: InstrumentSpec[]): ReplayDataset {
  const events: ReplayEvent[] = [];
  specs.forEach((value, index) => {
    events.push({
      sourceId: "registry",
      sequence: index + 1,
      exchangeTs: NOW - 10_000 + index,
      receivedAt: NOW - 10_000 + index,
      eventType: "instrument-listed",
      instrumentId: value.id,
      payload: {
        venue: value.venue,
        symbol: value.symbol,
        marketType: value.marketType,
        economicAssetId: value.economicAssetId,
        constraintVersion: 1,
        quantityStep: value.quantityStep,
        minimumQuantity: value.minimumQuantity,
        minimumNotional: value.minimumNotional
      }
    });
    events.push({
      sourceId: `depth:${index}`,
      sequence: 1,
      exchangeTs: NOW - 100 + index,
      receivedAt: NOW - 50 + index,
      eventType: "depth-snapshot",
      instrumentId: value.id,
      payload: { ...value.depth, complete: true, sequenceVerified: true, bookSequence: 10_000 + index, sourceGeneration: `fixture-generation:${index}` }
    });
  });
  events.sort(compareEvents);
  return { manifest: createReplayManifest(manifestInput(), events), events };
}

function engineManifest(dataset: ReplayDataset, engine: Parameters<typeof createEngineReplayManifest>[1]["engine"], input: unknown) {
  return createEngineReplayManifest(dataset, { evaluationId: `${engine}-proof`, engine, evaluatedAt: NOW, input, evidenceEventIndexes: depthIndexes(dataset) });
}

function depthIndexes(dataset: ReplayDataset) {
  return dataset.events.flatMap((event, index) => (event.eventType === "depth-snapshot" ? [index] : []));
}

function manifestInput() {
  return {
    datasetId: "multi-engine-fixture",
    createdAt: NOW,
    adapterVersions: { fixture: "1.0.0" },
    registrySnapshotId: "registry-fixture",
    registrySnapshotDigest: DIGEST,
    costModelVersion: "cost-fixture-v1",
    survivorshipPolicy: "point-in-time" as const,
    sourceFiles: [{ id: "fixture.json", digest: DIGEST }]
  };
}

function compareEvents(left: ReplayEvent, right: ReplayEvent) {
  return left.receivedAt - right.receivedAt || left.sourceId.localeCompare(right.sourceId) || left.sequence - right.sequence || left.exchangeTs - right.exchangeTs;
}

function triangularMarkets(): TriangularMarketMetadata[] {
  return [triangleMarket("BTC-USDT", "BTCUSDT", "BTC", "USDT", 10), triangleMarket("ETH-BTC", "ETHBTC", "ETH", "BTC", 0.0005), triangleMarket("ETH-USDT", "ETHUSDT", "ETH", "USDT", 10)];
}

function triangleMarket(marketId: string, symbol: string, baseAsset: string, quoteAsset: string, minimumNotional: number): TriangularMarketMetadata {
  return { marketId, venue: "testex", symbol, baseAsset, quoteAsset, quantityStep: 0.01, minimumQuantity: 0.01, minimumNotional, takerFeeBps: 5 };
}

function triangularDepth(index: number) {
  return [
    { bids: [[99.5, 1_000]], asks: [[100, 1_000]] },
    { bids: [[0.049, 100_000]], asks: [[0.05, 100_000]] },
    { bids: [[5.2, 100_000]], asks: [[5.3, 100_000]] }
  ][index]!;
}

function pairwiseInstruments(): PairwiseInstrument[] {
  return ["a", "b"].map((venue) => ({
    instrumentId: `${venue}:spot:BTCUSDT`,
    venue,
    symbol: "BTCUSDT",
    marketType: "spot",
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: { status: "reviewed", source: "fixture-registry", version: "v1", asOf: NOW - 100, validUntil: NOW + DAY },
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityModel: { unit: "base" },
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 1,
    takerFeeBps: 5
  }));
}

function pairwiseFamilyCases(): Array<{ instruments: [PairwiseInstrument, PairwiseInstrument]; route: PairwiseRoute }> {
  const source = (asOf = NOW - 100) => ({ source: "fixture", asOf });
  const convergence = (exitAt: number) => ({ ...source(), exitAt, expectedExitBasisBps: 0, longExitFeeBps: 1, shortExitFeeBps: 1 });
  const funding = (instrumentId: string, coversUntil: number) => ({ ...source(), instrumentId, cumulativeRateBps: 0, coversUntil, scheduleVerified: true as const, rateKind: "venue-estimate" as const });
  const make = (id: string, venue: string, marketType: PairwiseInstrument["marketType"], expiryTime?: number): PairwiseInstrument => ({
    ...pairwiseInstruments()[0]!,
    instrumentId: id,
    venue,
    symbol: id.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    marketType,
    ...(expiryTime ? { expiryTime } : {})
  });
  const spotA = make("a:spot:BTC", "a", "spot");
  const spotB = make("b:spot:BTC", "b", "spot");
  const perpA = make("a:perp:BTC", "a", "perpetual");
  const perpB = make("b:perp:BTC", "b", "perpetual");
  const near = NOW + 20 * DAY;
  const far = NOW + 40 * DAY;
  const futureA = make("a:future:BTC-NEAR", "a", "future", near);
  const futureBNear = make("b:future:BTC-NEAR", "b", "future", near);
  const futureAFar = make("a:future:BTC-FAR", "a", "future", far);
  return [
    {
      instruments: [spotA, spotB],
      route: {
        routeId: "spot-spot",
        strategyKind: "spot-spot",
        longInstrumentId: spotA.instrumentId,
        shortInstrumentId: spotB.instrumentId,
        requestedBaseQuantity: 1,
        longCapital: { ...source(), kind: "capital", availableQuoteQuantity: 1_000, availabilityVerified: true },
        shortAccess: { ...source(), kind: "inventory", availableBaseQuantity: 1, availabilityVerified: true },
        rebalance: { ...source(), costBps: 1 }
      }
    },
    {
      instruments: [perpA, perpB],
      route: {
        routeId: "perpetual-perpetual",
        strategyKind: "perpetual-perpetual",
        longInstrumentId: perpA.instrumentId,
        shortInstrumentId: perpB.instrumentId,
        requestedBaseQuantity: 1,
        convergence: convergence(NOW + 7 * DAY),
        funding: [funding(perpA.instrumentId, NOW + 7 * DAY), funding(perpB.instrumentId, NOW + 7 * DAY)]
      }
    },
    {
      instruments: [perpA, spotB],
      route: {
        routeId: "reverse-carry",
        strategyKind: "reverse-cash-and-carry",
        longInstrumentId: perpA.instrumentId,
        shortInstrumentId: spotB.instrumentId,
        requestedBaseQuantity: 1,
        convergence: convergence(NOW + 7 * DAY),
        borrow: { ...source(), kind: "borrow", availableBaseQuantity: 1, annualRateBps: 0, availabilityVerified: true, coversUntil: NOW + 7 * DAY },
        funding: [funding(perpA.instrumentId, NOW + 7 * DAY)]
      }
    },
    {
      instruments: [spotA, futureBNear],
      route: {
        routeId: "spot-dated-future",
        strategyKind: "spot-dated-future",
        longInstrumentId: spotA.instrumentId,
        shortInstrumentId: futureBNear.instrumentId,
        requestedBaseQuantity: 1,
        longCapital: { ...source(), kind: "capital", availableQuoteQuantity: 1_000, availabilityVerified: true },
        convergence: convergence(NOW + 7 * DAY),
        delivery: { ...source(), mode: "close-before-expiry", exitAt: NOW + 7 * DAY, deliveryFeeBps: 1 }
      }
    },
    {
      instruments: [perpA, futureBNear],
      route: {
        routeId: "perpetual-future",
        strategyKind: "perpetual-future",
        longInstrumentId: perpA.instrumentId,
        shortInstrumentId: futureBNear.instrumentId,
        requestedBaseQuantity: 1,
        convergence: convergence(NOW + 7 * DAY),
        funding: [funding(perpA.instrumentId, NOW + 7 * DAY)],
        delivery: { ...source(), mode: "close-before-expiry", exitAt: NOW + 7 * DAY, deliveryFeeBps: 1 }
      }
    },
    {
      instruments: [futureA, futureAFar],
      route: {
        routeId: "calendar-spread",
        strategyKind: "calendar-spread",
        longInstrumentId: futureA.instrumentId,
        shortInstrumentId: futureAFar.instrumentId,
        requestedBaseQuantity: 1,
        convergence: convergence(near),
        delivery: { ...source(), mode: "settle-near-roll-far", exitAt: near, nearInstrumentId: futureA.instrumentId, deliveryFeeBps: 1, settlementPriceSource: "fixture-index" }
      }
    },
    {
      instruments: [futureA, futureBNear],
      route: {
        routeId: "dated-futures-spread",
        strategyKind: "dated-futures-spread",
        longInstrumentId: futureA.instrumentId,
        shortInstrumentId: futureBNear.instrumentId,
        requestedBaseQuantity: 1,
        convergence: convergence(NOW + 7 * DAY),
        delivery: { ...source(), mode: "close-before-expiry", exitAt: NOW + 7 * DAY, deliveryFeeBps: 1 }
      }
    }
  ];
}

function pairwiseReplayInput(instruments: PairwiseInstrument[], route: PairwiseRoute): PairwiseReplayInput {
  return {
    instruments,
    routes: [route],
    evaluation: {
      minNetReturnBps: 0,
      maxQuoteAgeMs: 1_000,
      maxLegSkewMs: 100,
      maxFutureClockSkewMs: 100,
      maxAssumptionAgeMs: 1_000,
      maxEconomicIdentityAgeMs: 1_000,
      maxResidualDeltaBps: 1,
      pairingIterations: 20
    }
  };
}

function unit(assetId: string): NLegAssetUnit {
  return { venue: "testex", assetId, unitId: "native" };
}

function nLegMarkets(): NLegMarketMetadata[] {
  return [nLegMarket("A-USDT", "A", "USDT"), nLegMarket("B-A", "B", "A"), nLegMarket("C-B", "C", "B"), nLegMarket("C-USDT", "C", "USDT")];
}

function nLegMarket(instrumentId: string, baseId: string, quoteId: string): NLegMarketMetadata {
  const base = unit(baseId);
  const quote = unit(quoteId);
  return {
    instrumentId,
    venue: "testex",
    symbol: instrumentId.replace("-", ""),
    marketType: "spot",
    base,
    quote,
    quantityStep: 0.01,
    minimumQuantity: 0.01,
    minimumNotional: 0.01,
    buyFee: { scheduleId: `${instrumentId}-buy`, tierId: "vip-0", takerBps: 0, asset: base },
    sellFee: { scheduleId: `${instrumentId}-sell`, tierId: "vip-0", takerBps: 0, asset: quote }
  };
}

function option(instrumentId: string, optionType: "call" | "put"): OptionsParityInstrument {
  return {
    instrumentId,
    venue: "fixture",
    underlyingAsset: "BTC",
    strikeAsset: "USDC",
    settlementAsset: "USDC",
    premiumAsset: "USDC",
    expiryTime: NOW + 365 * DAY,
    strikePrice: 100,
    optionType,
    exerciseStyle: "european",
    automaticExercise: true,
    settlementProcess: "cash",
    quantityUnit: "base",
    basePerQuantityUnit: 1,
    quantityStep: 0.1,
    minimumQuantity: 0.1
  };
}

function optionAssumptions(instruments: OptionsParityInstrument[]): OptionsParityAssumptions {
  const sourced = { source: "fixture", asOf: NOW - 100 };
  return {
    valuationAsset: "USDC",
    riskFreeRate: { ...sourced, annualRate: 0 },
    dividendYield: { ...sourced, annualRate: 0 },
    settlement: {
      ...sourced,
      exerciseStyle: "european",
      automaticExercise: true,
      holdToExpiry: true,
      economicSettlement: "cash",
      settlementPriceSource: "fixture-index",
      acknowledgedProcesses: ["cash"]
    },
    premiumFx: { USDC: { ...sourced, fromAsset: "USDC", toAsset: "USDC", rate: 1 } },
    optionFees: Object.fromEntries(instruments.map((instrument) => [instrument.instrumentId, { ...sourced, model: { kind: "notional-bps", bps: 1 } }])),
    underlyingFee: { ...sourced, model: { kind: "notional-bps", bps: 1 } },
    shortOptionCapacity: Object.fromEntries(instruments.map((instrument) => [instrument.instrumentId, { ...sourced, availabilityVerified: true, marginVerified: true, availableBaseQuantity: 5 }])),
    underlyingShort: { ...sourced, borrowVerified: true, marginVerified: true, availableBaseQuantity: 5, annualBorrowRate: 0 }
  };
}

function nativeInstrument(): NativeSpreadInstrument {
  return {
    symbol: "BTCUSDT_FUNDING",
    contractType: "FundingRateArb",
    status: "Trading",
    baseCoin: "BTC",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: 0.01,
    minimumPrice: 0.01,
    maximumPrice: 100,
    quantityStep: 0.01,
    minimumQuantity: 0.01,
    maximumQuantity: 100,
    launchTime: NOW - DAY,
    legs: [
      { symbol: "BTCUSDT", contractType: "LinearPerpetual" },
      { symbol: "BTCUSDT-30SEP", contractType: "LinearFutures" }
    ]
  };
}
