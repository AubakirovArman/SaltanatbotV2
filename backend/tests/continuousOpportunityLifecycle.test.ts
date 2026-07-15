import { describe, expect, it } from "vitest";
import { attachContinuousRouteOpportunityLifecycle, continuousRouteDiscoveryToLifecycleSnapshot, CONTINUOUS_ROUTE_LIFECYCLE_UNIVERSE_ID, OpportunityLifecycleCoordinator } from "../src/arbitrage/lifecycle/index.js";
import type { ContinuousRouteDiscoverySnapshot } from "../src/arbitrage/upstream/publicFeeds/index.js";

describe("continuous route opportunity lifecycle", () => {
  it("keeps repeated market-only economics non-actionable without strategy evidence", () => {
    const coordinator = new OpportunityLifecycleCoordinator({ now: () => 2_000 });
    coordinator.ingest(continuousRouteDiscoveryToLifecycleSnapshot(fixture(1_000, 1)));
    coordinator.ingest(continuousRouteDiscoveryToLifecycleSnapshot(fixture(1_500, 2)));

    expect(coordinator.read({ universeId: CONTINUOUS_ROUTE_LIFECYCLE_UNIVERSE_ID }).routes).toMatchObject([{ kind: "pairwise", status: "first-seen", actionable: false, confirmationCount: 0, score: expect.any(Number), evidenceComplete: false }]);
  });

  it("skips market-data-blocked candidates and preserves their exact failure codes", () => {
    const atomic = fixture(1_000, 1);
    atomic.topBooks[0]!.continuity = { kind: "atomic-snapshot", protocol: "hyperliquid-block-snapshot", sequenceVerified: false };
    atomic.sources[0]!.status.state = "syncing";
    const current = atomic.marketEvaluations[0]!;
    if (current.status !== "market-only") throw new Error("expected market-only fixture");
    const { legs: _legs, capacity: _capacity, edges: _edges, freshness: _freshness, evidence: _evidence, ...blockedBase } = current;
    atomic.marketEvaluations = [
      {
        ...blockedBase,
        status: "blocked",
        blockedReasons: [{ code: "unverified-continuity", stage: "market-data", subject: current.longInstrumentId, message: "continuity missing" }]
      }
    ];
    atomic.marketEconomics.marketOnlyCandidates = 0;
    atomic.marketEconomics.blockedCandidates = 1;
    const converted = continuousRouteDiscoveryToLifecycleSnapshot(atomic);
    const coordinator = new OpportunityLifecycleCoordinator();
    coordinator.ingest(converted);

    expect(converted).toMatchObject({ candidates: [], coverage: { complete: false, stale: true, failedSources: expect.arrayContaining([expect.stringContaining("feed-not-live:syncing"), expect.stringContaining("unverified-continuity")]) } });
    expect(coordinator.read().routes).toEqual([]);
  });

  it("treats a Kraken Spot checksum proof as fresh without upgrading observed Futures sequences", () => {
    const checksum = fixture(1_000, 1);
    checksum.topBooks[0]!.continuity = { kind: "checksum-verified", sequence: 1, checksum: 2181137708, protocol: "kraken-spot-crc32" };
    expect(continuousRouteDiscoveryToLifecycleSnapshot(checksum).candidates[0]!.evidence[0]!.quality).toBe("fresh");

    checksum.topBooks[0]!.continuity = { kind: "sequence-observed", sequence: 1, protocol: "kraken-futures-seq", sequenceVerified: false };
    expect(continuousRouteDiscoveryToLifecycleSnapshot(checksum).candidates[0]!.evidence[0]!.quality).toBe("unverified");
  });

  it("attaches without letting a malformed update tear down the source", () => {
    const source = new FakeSource(fixture(1_000, 1));
    const coordinator = new OpportunityLifecycleCoordinator();
    const detach = attachContinuousRouteOpportunityLifecycle(source, coordinator);
    source.emit({ ...fixture(1_500, 2), capturedAt: -1 });
    source.emit(fixture(2_000, 3));

    expect(coordinator.read().runtime).toMatchObject({ acceptedSnapshots: 2, rejectedSnapshots: 1 });
    detach();
    expect(source.closed).toBe(true);
  });

  it("ingests a good candidate when another candidate is market-data blocked with zero evidence", () => {
    const mixed = fixture(1_000, 1);
    const goodCandidate = mixed.candidates[0]!;
    const goodEvaluation = mixed.marketEvaluations[0]!;
    const missingShortId = `${goodCandidate.shortInstrumentId}:missing`;
    const badRouteId = `${goodCandidate.routeId}:bad`;
    mixed.candidates.push({ ...goodCandidate, routeId: badRouteId, routeKey: JSON.stringify([goodCandidate.family, goodCandidate.longInstrumentId, missingShortId]), shortInstrumentId: missingShortId });
    if (goodEvaluation.status !== "market-only") throw new Error("expected market-only fixture");
    const { legs: _legs, capacity: _capacity, edges: _edges, freshness: _freshness, evidence: _evidence, ...blockedBase } = goodEvaluation;
    mixed.marketEvaluations.push({
      ...blockedBase,
      routeId: badRouteId,
      shortInstrumentId: missingShortId,
      status: "blocked",
      blockedReasons: [{ code: "missing-top-book", stage: "market-data", subject: missingShortId, message: "missing" }]
    });
    Object.assign(mixed.marketEconomics, {
      totalCandidates: 2,
      evaluatedCandidates: 2,
      marketOnlyCandidates: 1,
      blockedCandidates: 1,
      publishedEvaluations: 2,
      publishedMarketOnlyCandidates: 1,
      publishedBlockedCandidates: 1
    });
    mixed.totalCompatibleCandidates = 2;

    const converted = continuousRouteDiscoveryToLifecycleSnapshot(mixed);
    const coordinator = new OpportunityLifecycleCoordinator();
    expect(() => coordinator.ingest(converted)).not.toThrow();
    expect(converted.candidates.map(({ routeId }) => routeId)).toEqual([goodCandidate.routeId]);
    expect(converted.coverage).toMatchObject({ complete: false, failedSources: expect.arrayContaining([expect.stringContaining(`${badRouteId}:missing-top-book`)]) });
    expect(coordinator.read().routes).toMatchObject([{ routeId: goodCandidate.routeId, actionable: false, evidenceComplete: false }]);
  });

  it("propagates runtime retention and economics truncation into incomplete stale coverage", () => {
    const retained = fixture(1_000, 1);
    retained.runtimeCoverage = { complete: false, current: false, retainedPriorDiscovery: true, reason: "refresh-failed" };
    retained.marketEconomics.truncated = true;

    expect(continuousRouteDiscoveryToLifecycleSnapshot(retained).coverage).toEqual({
      complete: false,
      stale: true,
      truncated: true,
      failedSources: expect.arrayContaining(["continuous-runtime:refresh-failed"])
    });
  });

  it.each([
    "stale-top-book",
    "future-top-book",
    "skewed-top-books",
    "clock-unavailable",
    "clock-not-calibrated",
    "timestamp-definitely-future",
    "timestamp-may-be-future",
    "timestamp-stale",
    "clock-skew-exceeded"
  ] as const)("marks temporal market blocker %s as stale coverage", (code) => {
    const blocked = fixture(1_000, 1);
    const current = blocked.marketEvaluations[0]!;
    if (current.status !== "market-only") throw new Error("expected market-only fixture");
    const { legs: _legs, capacity: _capacity, edges: _edges, freshness: _freshness, evidence: _evidence, ...base } = current;
    blocked.marketEvaluations = [{ ...base, status: "blocked", blockedReasons: [{ code, stage: "market-data", subject: current.routeId, message: "temporal evidence unavailable" }] }];
    blocked.marketEconomics.marketOnlyCandidates = 0;
    blocked.marketEconomics.blockedCandidates = 1;

    expect(continuousRouteDiscoveryToLifecycleSnapshot(blocked).coverage).toMatchObject({ complete: false, stale: true });
  });

  it("bounds and hashes long diagnostic keys before lifecycle validation", () => {
    const blocked = fixture(1_000, 1);
    const longRouteId = `r${"a".repeat(198)}`;
    const longSubject = `okx:spot:${"A".repeat(190)}`;
    blocked.candidates[0]!.routeId = longRouteId;
    const current = blocked.marketEvaluations[0]!;
    if (current.status !== "market-only") throw new Error("expected market-only fixture");
    const { legs: _legs, capacity: _capacity, edges: _edges, freshness: _freshness, evidence: _evidence, ...base } = current;
    blocked.marketEvaluations = [
      {
        ...base,
        routeId: longRouteId,
        status: "blocked",
        blockedReasons: [{ code: "timestamp-stale", stage: "market-data", subject: longSubject, message: "stale" }]
      }
    ];
    blocked.marketEconomics.marketOnlyCandidates = 0;
    blocked.marketEconomics.blockedCandidates = 1;

    const converted = continuousRouteDiscoveryToLifecycleSnapshot(blocked);
    expect(converted.coverage.failedSources).toHaveLength(1);
    expect(converted.coverage.failedSources[0]).toContain(":sha256-");
    expect(converted.coverage.failedSources[0]!.length).toBeLessThanOrEqual(256);
    expect(() => new OpportunityLifecycleCoordinator().ingest(converted)).not.toThrow();
  });
});

class FakeSource {
  listener?: (snapshot: ContinuousRouteDiscoverySnapshot) => void;
  closed = false;

  constructor(private current: ContinuousRouteDiscoverySnapshot) {}

  subscribe(listener: (snapshot: ContinuousRouteDiscoverySnapshot) => void) {
    this.listener = listener;
    listener(this.current);
    return {
      close: () => {
        this.closed = true;
      }
    };
  }

  snapshot() {
    return this.current;
  }

  emit(snapshot: ContinuousRouteDiscoverySnapshot) {
    this.current = snapshot;
    this.listener?.(snapshot);
  }
}

function fixture(capturedAt: number, sequence: number): ContinuousRouteDiscoverySnapshot {
  const longId = "okx:spot:BTC-USDT";
  const shortId = "gate:spot:BTC_USDT";
  const continuity = { kind: "sequence-verified" as const, sequence, protocol: "okx-seqid" as const };
  const instrument = (venue: "okx" | "gate", instrumentId: string) => ({ venue, instrumentId, venueSymbol: instrumentId.split(":").at(-1)!, marketType: "spot" as const, quantityUnit: "base" as const });
  const status = (venue: "okx" | "gate", instrumentId: string) => ({ venue, instrumentId, state: "live" as const, message: "live", generation: 1 });
  const book = (venue: "okx" | "gate", instrumentId: string, bid: number, ask: number) => ({ venue, instrumentId, marketType: "spot" as const, quantityUnit: "base" as const, bid, bidSize: 2, ask, askSize: 2, exchangeTs: capturedAt - 10, receivedAt: capturedAt - 5, continuity, connectionGeneration: 1 });
  const longBook = book("okx", longId, 99, 100);
  const shortBook = book("gate", shortId, 101, 102);
  const routeId = "rf:cross-venue-spot-spot:test";
  const feePolicy = {
    version: "continuous-public-taker-fee-v1" as const,
    source: "operator-environment" as const,
    liquidity: "taker" as const,
    discountsApplied: false as const,
    rebatesApplied: false as const,
    feeAssetVerified: false as const,
    exposureImpactIncluded: false as const,
    coverage: "entry-only" as const
  };
  const evidence = (value: typeof longBook) => ({
    sourceId: `${value.venue}:public-websocket:${value.instrumentId}:okx-seqid:generation-1`,
    quality: "sequence-verified" as const,
    protocol: "okx-seqid",
    sequence,
    connectionGeneration: 1,
    exchangeTs: value.exchangeTs,
    receivedAt: value.receivedAt
  });
  const feeAssumption = {
    policyVersion: "continuous-public-taker-fee-v1" as const,
    source: "operator-environment" as const,
    accountTierVerified: false as const,
    discountsApplied: false as const,
    rebatesApplied: false as const,
    feeAssetVerified: false as const,
    exposureImpactIncluded: false as const
  };
  return {
    engine: "continuous-route-discovery-v1",
    executionStatus: "research-only",
    executable: false,
    capturedAt,
    runtimeCoverage: { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" },
    totalCompatibleCandidates: 1,
    truncated: false,
    candidates: [
      {
        routeKey: JSON.stringify(["cross-venue-spot-spot", longId, shortId]),
        routeId,
        family: "cross-venue-spot-spot",
        longInstrumentId: longId,
        shortInstrumentId: shortId,
        longMarketType: "spot",
        shortMarketType: "spot",
        economicAssetId: "crypto:bitcoin",
        edgeKind: "research-candidate",
        executable: false
      }
    ],
    marketEconomics: {
      engine: "continuous-market-economics-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      outcomeClass: "projected",
      evaluatedAt: capturedAt,
      totalCandidates: 1,
      evaluatedCandidates: 1,
      marketOnlyCandidates: 1,
      blockedCandidates: 0,
      publishedEvaluations: 1,
      publishedMarketOnlyCandidates: 1,
      publishedBlockedCandidates: 0,
      truncated: false,
      feePolicy
    },
    marketEvaluations: [
      {
        engine: "continuous-market-economics-v1",
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        strategyStatus: "blocked",
        evaluatedAt: capturedAt,
        routeId,
        family: "cross-venue-spot-spot",
        longInstrumentId: longId,
        shortInstrumentId: shortId,
        economicAssetId: "crypto:bitcoin",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        executionBoundary: { permission: false, orders: "not-supported", reason: "market-data-and-public-entry-fees-only" },
        status: "market-only",
        blockedReasons: [{ code: "account-capital-missing", stage: "strategy-evidence", subject: longId, message: "capital unavailable" }],
        legs: [
          {
            role: "long",
            side: "buy",
            instrumentId: longId,
            venue: "okx",
            symbol: "BTC-USDT",
            marketType: "spot",
            quantityUnit: "base",
            price: 100,
            topNativeQuantity: 2,
            alignedNativeCapacity: 2,
            usedNativeQuantity: 2,
            baseQuantity: 2,
            quoteNotional: 200,
            takerFeeBps: 5,
            publicEntryFeeQuoteEquivalentEstimate: 0.1,
            feeAssumption,
            bookEvidence: evidence(longBook)
          },
          {
            role: "short",
            side: "sell",
            instrumentId: shortId,
            venue: "gate",
            symbol: "BTC_USDT",
            marketType: "spot",
            quantityUnit: "base",
            price: 101,
            topNativeQuantity: 2,
            alignedNativeCapacity: 2,
            usedNativeQuantity: 2,
            baseQuantity: 2,
            quoteNotional: 202,
            takerFeeBps: 5,
            publicEntryFeeQuoteEquivalentEstimate: 0.101,
            feeAssumption,
            bookEvidence: evidence(shortBook)
          }
        ],
        capacity: { scope: "maximum-visible-top-book", matchedBaseQuantity: 2, commonBaseQuantity: 2, referenceNotionalQuote: 201, longAlignedBaseCapacity: 2, shortAlignedBaseCapacity: 2 },
        edges: {
          grossEntryValueDifferenceQuote: 2,
          grossEntryBasisBps: (2 / 201) * 10_000,
          publicEntryFeesQuoteEquivalentEstimate: 0.201,
          netEntryValueDifferenceAfterEstimatedFeesQuote: 1.799,
          netEntryBasisAfterEstimatedFeesBps: (1.799 / 201) * 10_000,
          coverage: "top-book-entry-and-public-taker-fees-only"
        },
        freshness: {
          status: "fresh",
          clockBasis: "calibrated-venue-interval",
          crossVenueComparable: true,
          quoteAgeMs: 10,
          legSkewMs: 0,
          maxBookAgeMs: 10_000,
          maxLegSkewMs: 1_000,
          oldestReceivedAt: capturedAt - 5,
          newestReceivedAt: capturedAt - 5,
          quoteAgeLowerMs: 10,
          quoteAgeUpperMs: 10,
          minimumPossibleLegSkewMs: 0,
          maximumPossibleLegSkewMs: 0,
          clockLegs: [
            { sourceId: "okx:public", exchangeTs: capturedAt - 10, clockStatus: "calibrated", ageLowerMs: 10, ageUpperMs: 10, localEventEarliestAt: capturedAt - 10, localEventLatestAt: capturedAt - 10 },
            { sourceId: "gate:public", exchangeTs: capturedAt - 10, clockStatus: "calibrated", ageLowerMs: 10, ageUpperMs: 10, localEventEarliestAt: capturedAt - 10, localEventLatestAt: capturedAt - 10 }
          ]
        },
        evidence: {
          marketDataComplete: true,
          continuityVerified: true,
          requiredStrategyEvidenceComplete: false,
          sourceIds: [evidence(longBook).sourceId, evidence(shortBook).sourceId],
          economicIdentities: [
            { instrumentId: longId, economicAssetId: "crypto:bitcoin", status: "reviewed", source: "test", version: "1", asOf: capturedAt - 100, validUntil: capturedAt + 100 },
            { instrumentId: shortId, economicAssetId: "crypto:bitcoin", status: "reviewed", source: "test", version: "1", asOf: capturedAt - 100, validUntil: capturedAt + 100 }
          ]
        }
      }
    ],
    instruments: [],
    routeReadyBooks: [],
    topBooks: [longBook, shortBook],
    fundingObservations: [],
    excludedBooks: [],
    rejectedInstruments: [],
    sources: [
      { instrument: instrument("okx", longId), status: status("okx", longId) },
      { instrument: instrument("gate", shortId), status: status("gate", shortId) }
    ]
  };
}
