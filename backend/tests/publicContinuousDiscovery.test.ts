import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRouteFamilyCandidates } from "../src/arbitrage/routeFamilies/index.js";
import type { VenueClockAssessmentProvider } from "../src/arbitrage/timing/index.js";
import { buildContinuousRouteDiscovery, ContinuousRouteFamilyDiscovery, pairwiseBookFromContinuous, type ContinuousDiscoveryInstrument, type ContinuousRouteDiscoverySnapshot } from "../src/arbitrage/upstream/publicFeeds/discovery.js";
import { ContinuousPublicFeedHub } from "../src/arbitrage/upstream/publicFeeds/hub.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousFeedSnapshot, ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";

const NOW = 1_784_000_000_500;

afterEach(() => vi.useRealTimers());

describe("continuous route-family discovery bridge", () => {
  it("discovers multi-venue families but exposes only protocol-sequenced books as route-ready", () => {
    const okxSpot = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const gateSpot = registry("gate", "spot", "BTC_USDT", "USDT", "base");
    const okxPerp = registry("okx", "perpetual", "BTC-USDT-SWAP", "USDT", "contract");
    const gatePerp = registry("gate", "perpetual", "BTC_USDT", "USDT", "contract");
    const hyperPerp = registry("hyperliquid", "perpetual", "BTC", "USDC", "base");
    const values = [okxSpot, gateSpot, okxPerp, gatePerp, hyperPerp].map(discoveryInput);
    const sources = [snapshot(okxSpot, sequenceBook(okxSpot, "okx-seqid", 10)), snapshot(gateSpot, sequenceBook(gateSpot, "gate-update-id", 20)), snapshot(okxPerp, sequenceBook(okxPerp, "okx-seqid", 30)), snapshot(gatePerp, sequenceBook(gatePerp, "gate-update-id", 40)), snapshot(hyperPerp, atomicBook(hyperPerp))];
    sources[2]!.funding = {
      venue: "okx",
      instrumentId: okxPerp.id,
      currentEstimateRate: 0.0001,
      nextFundingTime: NOW + 60_000,
      intervalMinutes: 60,
      scheduleVerified: true,
      exchangeTs: NOW,
      exchangeTimestampVerified: true,
      receivedAt: NOW,
      source: "public-websocket",
      connectionGeneration: 1
    };
    const result = buildContinuousRouteDiscovery(values, sources, { capturedAt: NOW, maxCandidates: 100, clockCalibration: calibratedClock });

    expect(result).toMatchObject({ engine: "continuous-route-discovery-v1", executionStatus: "research-only", executable: false, truncated: false });
    expect(result.candidates.filter((value) => value.family === "cross-venue-spot-spot")).toHaveLength(2);
    expect(result.candidates.filter((value) => value.family === "perpetual-perpetual-funding")).toHaveLength(2);
    expect(result.marketEconomics).toMatchObject({ engine: "continuous-market-economics-v1", readOnly: true, researchOnly: true, executable: false, outcomeClass: "projected", evaluatedCandidates: result.candidates.length, marketOnlyCandidates: 2, blockedCandidates: 6, truncated: false });
    expect(result.marketEvaluations).toHaveLength(result.candidates.length);
    expect(result.marketEvaluations.every((value) => value.strategyStatus === "blocked" && value.executable === false && value.blockedReasons.some((reason) => reason.stage === "strategy-evidence"))).toBe(true);
    expect(result.marketEvaluations.filter((value) => value.status === "blocked").every((value) => value.blockedReasons.some(({ code }) => code === "minimum-notional"))).toBe(true);
    expect(result.routeReadyBooks.map((value) => value.instrumentId).sort()).toEqual([gatePerp.id, gateSpot.id, okxPerp.id, okxSpot.id].sort());
    expect(result.excludedBooks).toEqual([{ instrumentId: hyperPerp.id, reason: expect.stringMatching(/atomic snapshots/) }]);
    expect(result.fundingObservations).toHaveLength(1);
    expect(result.fundingObservations[0]).not.toHaveProperty("cumulativeRateBps");
  });

  it("rejects stale or non-positive-sequence publications before pairwise evaluation", () => {
    const value = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const zero = sequenceBook(value, "okx-seqid", 0);
    expect(pairwiseBookFromContinuous(zero, NOW, 10_000)).toMatch(/positive safe integer/);
    const stale = sequenceBook(value, "okx-seqid", 1);
    stale.receivedAt = NOW - 10_001;
    expect(pairwiseBookFromContinuous(stale, NOW, 10_000)).toMatch(/older than 10000/);
  });

  it("continuously rebuilds a bounded discovery snapshot from hub publications", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const callbacks = new Map<string, ContinuousFeedCallbacks>();
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      feedFactory: (value, next) => {
        callbacks.set(value.instrumentId, next);
        return { start: () => undefined, close: () => undefined };
      }
    });
    const okx = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const gate = registry("gate", "spot", "BTC_USDT", "USDT", "base");
    const scanner = new ContinuousRouteFamilyDiscovery(hub, { now: () => NOW, monotonicNow: () => monotonicNow, maxSubscriptions: 2, clockCalibration: calibratedClock });
    scanner.configure([discoveryInput(okx), discoveryInput(gate)]);
    const emissions: number[] = [];
    const subscription = scanner.subscribe((value) => emissions.push(value.routeReadyBooks.length));
    callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", 1));
    callbacks.get(gate.id)?.onBook(sequenceBook(gate, "gate-update-id", 1));
    expect(scanner.snapshot()).toMatchObject({ totalCompatibleCandidates: 2, routeReadyBooks: [{ instrumentId: gate.id }, { instrumentId: okx.id }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(emissions.at(-1)).toBe(2);
    callbacks.get(okx.id)?.onInvalidate("gap");
    expect(scanner.snapshot().routeReadyBooks.map((value) => value.instrumentId)).toEqual([gate.id]);
    monotonicNow = 250;
    await vi.advanceTimersByTimeAsync(250);
    expect(emissions.at(-1)).toBe(1);
    subscription.close();
    scanner.close();
    hub.close();
  });

  it("coalesces a public-book event storm, yields to unrelated timers, and enforces the rebuild cadence", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const callbacks = new Map<string, ContinuousFeedCallbacks>();
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      feedFactory: (value, next) => {
        callbacks.set(value.instrumentId, next);
        return { start: () => undefined, close: () => undefined };
      }
    });
    const okx = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const gate = registry("gate", "spot", "BTC_USDT", "USDT", "base");
    const scanner = new ContinuousRouteFamilyDiscovery(hub, { now: () => NOW, monotonicNow: () => monotonicNow, maxSubscriptions: 2, emitIntervalMs: 100, clockCalibration: calibratedClock });
    scanner.configure([discoveryInput(okx), discoveryInput(gate)]);
    const emissions: ContinuousRouteDiscoverySnapshot[] = [];
    const subscription = scanner.subscribe((value) => emissions.push(value));
    const unrelatedTimer = vi.fn();
    setTimeout(unrelatedTimer, 0);

    for (let sequence = 1; sequence <= 5_000; sequence += 1) {
      callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", sequence));
      callbacks.get(gate.id)?.onBook(sequenceBook(gate, "gate-update-id", sequence));
      callbacks.get(okx.id)?.onStatus({ venue: "okx", instrumentId: okx.id, state: "live", message: "live", generation: 1 });
      callbacks.get(gate.id)?.onStatus({ venue: "gate", instrumentId: gate.id, state: "live", message: "live", generation: 1 });
    }

    // The synchronous producer loop queues one discovery macrotask rather than
    // recursively evaluating 20,000 book/status callbacks.
    expect(emissions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(unrelatedTimer).toHaveBeenCalledOnce();
    expect(emissions).toHaveLength(2);
    expect(emissions.at(-1)?.routeReadyBooks.map((book) => book.sequence)).toEqual([5_000, 5_000]);

    for (let sequence = 5_001; sequence <= 6_000; sequence += 1) callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", sequence));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(emissions).toHaveLength(2);
    monotonicNow = 100;
    await vi.advanceTimersByTimeAsync(1);
    expect(emissions).toHaveLength(3);
    expect(emissions.at(-1)?.routeReadyBooks.find((book) => book.instrumentId === okx.id)?.sequence).toBe(6_000);

    subscription.close();
    scanner.close();
    hub.close();
  });

  it("hard-rate-limits invalidation and reconnect storms while publishing the latest truth", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const callbacks = new Map<string, ContinuousFeedCallbacks>();
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      feedFactory: (value, next) => {
        callbacks.set(value.instrumentId, next);
        return { start: () => undefined, close: () => undefined };
      }
    });
    const okx = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const scanner = new ContinuousRouteFamilyDiscovery(hub, { now: () => NOW, monotonicNow: () => monotonicNow, maxSubscriptions: 1, emitIntervalMs: 1_000, clockCalibration: calibratedClock });
    scanner.configure([discoveryInput(okx)]);
    const emissions: ContinuousRouteDiscoverySnapshot[] = [];
    const subscription = scanner.subscribe((value) => emissions.push(value));

    callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(emissions).toHaveLength(2);

    for (let generation = 2; generation <= 5_001; generation += 1) {
      callbacks.get(okx.id)?.onInvalidate("reconnect");
      callbacks.get(okx.id)?.onStatus({ venue: "okx", instrumentId: okx.id, state: "reconnecting", message: "retrying", generation });
      callbacks.get(okx.id)?.onBook({ ...sequenceBook(okx, "okx-seqid", generation), connectionGeneration: generation });
    }

    expect(emissions).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(emissions).toHaveLength(2);
    monotonicNow = 250;
    await vi.advanceTimersByTimeAsync(1);
    expect(emissions).toHaveLength(3);
    const latestBook = emissions.at(-1)?.sources[0]?.book;
    expect(latestBook?.continuity.kind === "sequence-verified" ? latestBook.continuity.sequence : undefined).toBe(5_001);
    expect(emissions.at(-1)?.sources[0]?.status.generation).toBe(5_001);

    subscription.close();
    scanner.close();
    hub.close();
  });

  it("uses monotonic cadence across wall-clock rollback and forward jumps", async () => {
    vi.useFakeTimers();
    let wallNow = NOW;
    let monotonicNow = 0;
    const callbacks = new Map<string, ContinuousFeedCallbacks>();
    const hub = new ContinuousPublicFeedHub({
      now: () => wallNow,
      feedFactory: (value, next) => {
        callbacks.set(value.instrumentId, next);
        return { start: () => undefined, close: () => undefined };
      }
    });
    const okx = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const scanner = new ContinuousRouteFamilyDiscovery(hub, {
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      maxSubscriptions: 1,
      emitIntervalMs: 1_000,
      clockCalibration: calibratedClock
    });
    scanner.configure([discoveryInput(okx)]);
    const emissions: ContinuousRouteDiscoverySnapshot[] = [];
    scanner.subscribe((value) => emissions.push(value));
    callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(emissions).toHaveLength(2);

    wallNow -= 100_000;
    monotonicNow = 10;
    callbacks.get(okx.id)?.onInvalidate("rollback");
    await vi.advanceTimersByTimeAsync(239);
    expect(emissions).toHaveLength(2);
    monotonicNow = 250;
    await vi.advanceTimersByTimeAsync(1);
    expect(emissions).toHaveLength(3);
    expect(emissions.at(-1)?.capturedAt).toBe(wallNow);

    wallNow += 10_000_000;
    monotonicNow = 260;
    callbacks.get(okx.id)?.onBook({ ...sequenceBook(okx, "okx-seqid", 2), receivedAt: wallNow, exchangeTs: wallNow });
    expect(vi.getTimerCount()).toBe(1);
    monotonicNow = 300;
    callbacks.get(okx.id)?.onInvalidate("forward-jump");
    await vi.advanceTimersByTimeAsync(199);
    expect(emissions).toHaveLength(3);
    monotonicNow = 500;
    await vi.advanceTimersByTimeAsync(1);
    expect(emissions).toHaveLength(4);

    scanner.close();
    hub.close();
  });

  it("isolates listener mutation and exceptions without aborting later listeners", async () => {
    vi.useFakeTimers();
    const callbacks = new Map<string, ContinuousFeedCallbacks>();
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      feedFactory: (value, next) => {
        callbacks.set(value.instrumentId, next);
        return { start: () => undefined, close: () => undefined };
      }
    });
    const okx = registry("okx", "spot", "BTC-USDT", "USDT", "base");
    const scanner = new ContinuousRouteFamilyDiscovery(hub, { now: () => NOW, maxSubscriptions: 1, clockCalibration: calibratedClock });
    scanner.configure([discoveryInput(okx)]);
    let hostileCalls = 0;
    expect(() =>
      scanner.subscribe((value) => {
        hostileCalls += 1;
        value.sources.length = 0;
        throw new Error("hostile listener");
      })
    ).not.toThrow();
    const observed: ContinuousRouteDiscoverySnapshot[] = [];
    scanner.subscribe((value) => observed.push(value));
    callbacks.get(okx.id)?.onBook(sequenceBook(okx, "okx-seqid", 1));
    await vi.advanceTimersByTimeAsync(0);

    expect(hostileCalls).toBe(2);
    expect(observed).toHaveLength(2);
    expect(observed.at(-1)?.sources).toHaveLength(1);
    expect(observed.at(-1)?.routeReadyBooks).toHaveLength(1);

    scanner.close();
    hub.close();
  });

  it("economically ranks the complete >200 route universe before publishing a bounded result", () => {
    const okx = Array.from({ length: 12 }, (_, index) => registry("okx", "spot", `BTC-${String(index).padStart(2, "0")}`, "USDT", "base"));
    const gate = Array.from({ length: 12 }, (_, index) => registry("gate", "spot", `BTC_${String(index).padStart(2, "0")}`, "USDT", "base"));
    const values = [...okx, ...gate].map(discoveryInput);
    const sources = [...okx, ...gate].map((instrument, index) => snapshot(instrument, sequenceBook(instrument, instrument.venue === "gate" ? "gate-update-id" : "okx-seqid", index + 1)));
    const bestLong = okx.at(-1)!;
    const bestShort = gate.at(-1)!;
    setSourcePrices(sources.find(({ instrument }) => instrument.instrumentId === bestLong.id)!, 89, 90);
    setSourcePrices(sources.find(({ instrument }) => instrument.instrumentId === bestShort.id)!, 120, 121);

    const result = buildContinuousRouteDiscovery(values, sources, { capturedAt: NOW, maxCandidates: 200, clockCalibration: calibratedClock });
    const oldIdentifierSlice = discoverRouteFamilyCandidates(result.instruments, { families: ["cross-venue-spot-spot"], maxCandidates: 200 });
    expect(oldIdentifierSlice.candidates.some(({ longInstrumentId, shortInstrumentId }) => longInstrumentId === bestLong.id && shortInstrumentId === bestShort.id)).toBe(false);

    expect(result).toMatchObject({ totalCompatibleCandidates: 288, truncated: true });
    expect(result.candidates).toHaveLength(200);
    expect(result.marketEconomics).toMatchObject({
      totalCandidates: 288,
      evaluatedCandidates: 288,
      marketOnlyCandidates: 288,
      blockedCandidates: 0,
      publishedEvaluations: 200,
      publishedMarketOnlyCandidates: 200,
      publishedBlockedCandidates: 0,
      truncated: true
    });
    expect(result.marketEvaluations[0]).toMatchObject({ status: "market-only", longInstrumentId: bestLong.id, shortInstrumentId: bestShort.id });
    expect(result.candidates[0]).toMatchObject({ longInstrumentId: bestLong.id, shortInstrumentId: bestShort.id });
    if (result.marketEvaluations[0]?.status !== "market-only") throw new Error("expected the best route to have market economics");
    expect(result.marketEvaluations[0].edges.netEntryBasisAfterEstimatedFeesBps).toBeGreaterThan(2_800);

    const reversed = buildContinuousRouteDiscovery([...values].reverse(), [...sources].reverse(), { capturedAt: NOW, maxCandidates: 200, clockCalibration: calibratedClock });
    expect(reversed.candidates.map(({ routeId }) => routeId)).toEqual(result.candidates.map(({ routeId }) => routeId));
    expect(reversed.marketEvaluations.map(({ routeId }) => routeId)).toEqual(result.marketEvaluations.map(({ routeId }) => routeId));
  });

  it("enforces the proved work bound and cooperatively cancels before discovery", () => {
    const oversized = Array.from({ length: 25 }, (_, index) => registry(index % 2 === 0 ? "okx" : "gate", "spot", `BTC-${index}`, "USDT", "base")).map(discoveryInput);
    expect(() => buildContinuousRouteDiscovery(oversized, [], { capturedAt: NOW })).toThrow(/at most 24 instruments/);

    const controller = new AbortController();
    controller.abort(new Error("operator cancelled ranking"));
    expect(() => buildContinuousRouteDiscovery([], [], { capturedAt: NOW, signal: controller.signal })).toThrow(/operator cancelled ranking/);
  });
});

function discoveryInput(instrument: RegistryInstrument): ContinuousDiscoveryInstrument {
  return {
    instrument,
    overlay: {
      takerFeeBps: 5,
      economicIdentity: { status: "reviewed", source: "test-registry", version: "1", asOf: NOW - 1_000, validUntil: NOW + 60_000 }
    }
  };
}

function registry(venue: "okx" | "gate" | "hyperliquid", marketType: "spot" | "perpetual", venueSymbol: string, quoteAsset: "USDT" | "USDC", quantityUnit: "base" | "contract"): RegistryInstrument {
  return {
    id: `${venue}:${marketType}:${venueSymbol}`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol,
    baseAsset: "BTC",
    quoteAsset,
    settleAsset: quoteAsset,
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const, contractValueCurrency: "BTC" } : {}),
    contractMultiplier: quantityUnit === "contract" ? 0.001 : 1,
    quantityUnit,
    tickSize: 0.1,
    quantityStep: quantityUnit === "contract" ? 1 : 0.001,
    minimumQuantity: quantityUnit === "contract" ? 1 : 0.001,
    minimumNotional: 5,
    status: "trading"
  };
}

function snapshot(instrument: RegistryInstrument, book: ContinuousPublicBook): ContinuousFeedSnapshot {
  const feed = continuousInstrument(instrument);
  return {
    instrument: feed,
    status: { venue: feed.venue, instrumentId: feed.instrumentId, state: "live", message: "live", generation: 1 },
    book,
    topBook: {
      venue: feed.venue,
      instrumentId: feed.instrumentId,
      marketType: feed.marketType,
      quantityUnit: feed.quantityUnit,
      bid: 100,
      bidSize: 2,
      ask: 101,
      askSize: 2,
      exchangeTs: NOW,
      receivedAt: NOW,
      continuity: book.continuity,
      connectionGeneration: 1
    }
  };
}

function setSourcePrices(source: ContinuousFeedSnapshot, bid: number, ask: number) {
  if (!source.book || !source.topBook) throw new Error("expected a complete source fixture");
  source.book.bids = [[bid, 2]];
  source.book.asks = [[ask, 2]];
  source.topBook.bid = bid;
  source.topBook.ask = ask;
}

function sequenceBook(instrument: RegistryInstrument, protocol: "okx-seqid" | "gate-update-id", sequence: number): ContinuousPublicBook {
  const feed = continuousInstrument(instrument);
  return {
    venue: feed.venue,
    instrumentId: feed.instrumentId,
    venueSymbol: feed.venueSymbol,
    marketType: feed.marketType,
    quantityUnit: feed.quantityUnit,
    bids: [[100, 2]],
    asks: [[101, 2]],
    exchangeTs: NOW,
    receivedAt: NOW,
    complete: true,
    continuity: { kind: "sequence-verified", sequence, protocol },
    source: "public-websocket",
    connectionGeneration: 1,
    retainedDepth: 100
  };
}

function atomicBook(instrument: RegistryInstrument): ContinuousPublicBook {
  const feed = continuousInstrument(instrument);
  return {
    ...sequenceBook(instrument, "okx-seqid", 1),
    venue: "hyperliquid",
    continuity: { kind: "atomic-snapshot", protocol: "hyperliquid-block-snapshot", sequenceVerified: false },
    quantityUnit: feed.quantityUnit
  };
}

function continuousInstrument(value: RegistryInstrument): ContinuousFeedInstrument {
  return {
    venue: value.venue as ContinuousFeedInstrument["venue"],
    instrumentId: value.id,
    venueSymbol: value.venueSymbol,
    marketType: value.marketType as ContinuousFeedInstrument["marketType"],
    quantityUnit: value.quantityUnit!
  };
}

const calibratedClock: VenueClockAssessmentProvider = {
  assessTimestamp(sourceId, exchangeTimestamp, evaluatedAt) {
    const ageMs = evaluatedAt - exchangeTimestamp;
    return {
      sourceId,
      exchangeTimestamp,
      evaluatedAt,
      clockStatus: "calibrated",
      eligible: true,
      quality: "verified",
      ageLowerMs: ageMs,
      ageUpperMs: ageMs,
      localEventEarliestAt: exchangeTimestamp,
      localEventLatestAt: exchangeTimestamp
    };
  },
  assessSkew(left, right, maximumSkewMs) {
    if (left.localEventEarliestAt === undefined || right.localEventEarliestAt === undefined) return { eligible: false, reason: "clock-unavailable" };
    const skew = Math.abs(left.localEventEarliestAt - right.localEventEarliestAt);
    return { eligible: skew <= maximumSkewMs, minimumPossibleSkewMs: skew, maximumPossibleSkewMs: skew, ...(skew > maximumSkewMs ? { reason: "skew-exceeded" as const } : {}) };
  }
};
