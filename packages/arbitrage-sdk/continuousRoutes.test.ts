import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseContinuousRouteLiveResponse } from "./continuousRoutes.js";

describe("continuous route live SDK", () => {
  it("parses a bounded read-only live view", () => {
    expect(parseContinuousRouteLiveResponse(fixture())).toMatchObject({
      state: "live",
      readOnly: true,
      executable: false,
      discovery: { routeReadyBookCount: 1, candidates: [{ family: "cross-venue-spot-spot" }], sources: [{ state: "live" }] }
    });
  });

  it("accepts the additive market-only economics pair and preserves its blocked boundary", () => {
    expect(parseContinuousRouteLiveResponse(economicsFixture())).toMatchObject({
      discovery: {
        marketEconomics: { evaluatedCandidates: 1, publishedEvaluations: 1, marketOnlyCandidates: 1, blockedCandidates: 0, executable: false },
        marketEvaluations: [
          {
            status: "market-only",
            strategyStatus: "blocked",
            executionBoundary: { permission: false, orders: "not-supported" },
            capacity: { scope: "maximum-visible-top-book", matchedBaseQuantity: 1.5 },
            evidence: { requiredStrategyEvidenceComplete: false }
          }
        ]
      }
    });
  });

  it("rejects forged calibrated-clock provenance on a cross-venue market row", () => {
    const value = economicsFixture();
    (value.discovery.marketEvaluations[0]!.freshness.clockLegs[0] as unknown as Record<string, unknown>).sourceId = "gate:public";
    expect(() => parseContinuousRouteLiveResponse(value)).toThrow(/clock provenance/);
  });

  it("requires both economics siblings while accepting an old server with neither", () => {
    expect(parseContinuousRouteLiveResponse(fixture()).discovery.marketEconomics).toBeUndefined();
    const missingEvaluations = economicsFixture();
    (missingEvaluations.discovery as Record<string, unknown>).marketEvaluations = undefined;
    expect(() => parseContinuousRouteLiveResponse(missingEvaluations)).toThrow(/siblings must be present together/);
    const missingSummary = economicsFixture();
    (missingSummary.discovery as Record<string, unknown>).marketEconomics = undefined;
    expect(() => parseContinuousRouteLiveResponse(missingSummary)).toThrow(/siblings must be present together/);
  });

  it("rejects forged execution, evidence upgrades and market arithmetic", () => {
    const ready = economicsFixture();
    (ready.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).strategyStatus = "ready";
    expect(() => parseContinuousRouteLiveResponse(ready)).toThrow(/safety envelope/);

    const executable = economicsFixture();
    ((executable.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).executionBoundary as Record<string, unknown>).permission = true;
    expect(() => parseContinuousRouteLiveResponse(executable)).toThrow(/execution boundary/);

    const evidence = economicsFixture();
    ((evidence.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).evidence as Record<string, unknown>).requiredStrategyEvidenceComplete = true;
    expect(() => parseContinuousRouteLiveResponse(evidence)).toThrow(/evidence boundary/);

    const provenance = economicsFixture();
    const identities = ((provenance.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).evidence as Record<string, unknown>).economicIdentities as Array<Record<string, unknown>>;
    identities[0]!.version = "forged";
    expect(() => parseContinuousRouteLiveResponse(provenance)).toThrow(/provenance is inconsistent/);

    const futureIdentity = economicsFixture();
    futureIdentity.discovery.instruments[0]!.economicIdentity.asOf = 2_200;
    futureIdentity.discovery.instruments[0]!.economicIdentity.validUntil = 3_000;
    const futureEvidence = ((futureIdentity.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).evidence as Record<string, unknown>).economicIdentities as Array<Record<string, unknown>>;
    futureEvidence[0]!.asOf = 2_200;
    expect(() => parseContinuousRouteLiveResponse(futureIdentity)).toThrow(/not valid at evaluatedAt/);

    const arithmetic = economicsFixture();
    ((arithmetic.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).edges as Record<string, unknown>).netEntryValueDifferenceAfterEstimatedFeesQuote = 999;
    expect(() => parseContinuousRouteLiveResponse(arithmetic)).toThrow(/netEntryValueDifferenceAfterEstimatedFeesQuote is inconsistent/);

    const fee = economicsFixture();
    (fee.discovery.marketEvaluations[0]!.legs[0] as unknown as Record<string, unknown>).publicEntryFeeQuoteEquivalentEstimate = 999;
    expect(() => parseContinuousRouteLiveResponse(fee)).toThrow(/publicEntryFeeQuoteEquivalentEstimate is inconsistent/);

    const feeAuthority = economicsFixture();
    (feeAuthority.discovery.marketEconomics.feePolicy as unknown as Record<string, unknown>).feeAssetVerified = true;
    expect(() => parseContinuousRouteLiveResponse(feeAuthority)).toThrow(/fee policy is invalid/);

    const capacity = economicsFixture();
    ((capacity.discovery.marketEvaluations[0] as unknown as Record<string, unknown>).capacity as Record<string, unknown>).matchedBaseQuantity = 0.5;
    expect(() => parseContinuousRouteLiveResponse(capacity)).toThrow(/matchedBaseQuantity is inconsistent/);
  });

  it("rejects count, candidate, generation and continuity-proof forgery", () => {
    const counts = economicsFixture();
    counts.discovery.marketEconomics.marketOnlyCandidates = 0;
    expect(() => parseContinuousRouteLiveResponse(counts)).toThrow(/status counts/);

    const candidate = economicsFixture();
    candidate.discovery.marketEvaluations[0]!.routeId = "rf:cross-venue-spot-spot:000000000000000000000000";
    expect(() => parseContinuousRouteLiveResponse(candidate)).toThrow(/candidate identity/);

    const generation = economicsFixture();
    generation.discovery.sources[0]!.status.generation = 2;
    expect(() => parseContinuousRouteLiveResponse(generation)).toThrow(/source generation/);

    const checksum = economicsFixture();
    ((checksum.discovery.marketEvaluations[0]!.legs[0] as unknown as Record<string, unknown>).bookEvidence as Record<string, unknown>).checksum = 123;
    expect(() => parseContinuousRouteLiveResponse(checksum)).toThrow(/cannot claim a checksum/);
  });

  it("accepts a genuinely blocked row and rejects market-only fields attached to it", () => {
    const blocked = blockedEconomicsFixture();
    expect(parseContinuousRouteLiveResponse(blocked).discovery.marketEvaluations?.[0]).toMatchObject({ status: "blocked", strategyStatus: "blocked" });

    const forged = blockedEconomicsFixture();
    (forged.discovery.marketEvaluations[0] as Record<string, unknown>).edges = { netEntryValueDifferenceAfterEstimatedFeesQuote: 100 };
    expect(() => parseContinuousRouteLiveResponse(forged)).toThrow(/unsupported field edges/);
  });

  it("enforces evaluation bounds and exact truncation semantics", () => {
    const tooMany = economicsFixture();
    (tooMany.discovery as unknown as Record<string, unknown>).marketEvaluations = Array.from({ length: 501 }, () => tooMany.discovery.marketEvaluations[0]);
    expect(() => parseContinuousRouteLiveResponse(tooMany)).toThrow(/at most 500 rows/);

    const truncation = economicsFixture();
    truncation.discovery.marketEconomics.truncated = true;
    expect(() => parseContinuousRouteLiveResponse(truncation)).toThrow(/truncation is inconsistent/);

    const total = economicsFixture();
    total.discovery.marketEconomics.totalCandidates = 2;
    expect(() => parseContinuousRouteLiveResponse(total)).toThrow(/discovery totals/);
  });

  it("distinguishes the completely evaluated universe from bounded published rows", () => {
    const bounded = economicsFixture();
    bounded.discovery.totalCompatibleCandidates = 2;
    bounded.discovery.truncated = true;
    Object.assign(bounded.discovery.marketEconomics, {
      totalCandidates: 2,
      evaluatedCandidates: 2,
      marketOnlyCandidates: 2,
      blockedCandidates: 0,
      publishedEvaluations: 1,
      publishedMarketOnlyCandidates: 1,
      publishedBlockedCandidates: 0,
      truncated: true
    });
    expect(parseContinuousRouteLiveResponse(bounded).discovery.marketEconomics).toMatchObject({
      totalCandidates: 2,
      evaluatedCandidates: 2,
      publishedEvaluations: 1,
      truncated: true
    });

    const forged = structuredClone(bounded);
    forged.discovery.marketEconomics.publishedMarketOnlyCandidates = 0;
    expect(() => parseContinuousRouteLiveResponse(forged)).toThrow(/status counts/);
  });

  it("accepts exact Kraken checksum evidence and rejects a mismatched checksum", () => {
    const checksum = checksumEconomicsFixture();
    const parsed = parseContinuousRouteLiveResponse(checksum).discovery.marketEvaluations?.[0];
    expect(parsed).toMatchObject({ status: "market-only" });
    expect(parsed?.status === "market-only" ? parsed.legs[0].bookEvidence : undefined).toMatchObject({ quality: "checksum-verified", checksum: 3_630_265_277 });
    (((checksum.discovery.marketEvaluations[0] as Record<string, unknown>).legs as Array<Record<string, unknown>>)[0]!.bookEvidence as Record<string, unknown>).checksum = 1;
    expect(() => parseContinuousRouteLiveResponse(checksum)).toThrow(/checksum is inconsistent/);
  });

  it("accepts the reviewed KuCoin OBU range proof in strict market-economics evidence", () => {
    const response = economicsFixture();
    (response.discovery.instruments[0] as unknown as Record<string, unknown>).venue = "kucoin";
    const topBook = response.discovery.topBooks[0]! as unknown as Record<string, unknown>;
    const continuity = { kind: "sequence-verified", sequence: 10, protocol: "kucoin-obu-range" };
    topBook.venue = "kucoin";
    topBook.continuity = continuity;
    const source = response.discovery.sources[0] as unknown as { instrument: Record<string, unknown>; status: Record<string, unknown>; topBook: Record<string, unknown> };
    source.instrument.venue = "kucoin";
    source.status.venue = "kucoin";
    const sourceTopBook = source.topBook;
    sourceTopBook.venue = "kucoin";
    sourceTopBook.continuity = continuity;
    const leg = response.discovery.marketEvaluations[0]!.legs[0] as unknown as Record<string, unknown>;
    leg.venue = "kucoin";
    const evidence = leg.bookEvidence as Record<string, unknown>;
    evidence.protocol = "kucoin-obu-range";
    evidence.sourceId = `kucoin:public-websocket:${response.activeInstrumentIds[0]}:kucoin-obu-range:generation-1`;
    const evaluationEvidence = response.discovery.marketEvaluations[0]!.evidence as unknown as Record<string, unknown>;
    (evaluationEvidence.sourceIds as string[])[0] = evidence.sourceId as string;
    (response.discovery.marketEvaluations[0]!.freshness.clockLegs[0] as unknown as Record<string, unknown>).sourceId = "kucoin:public";

    expect(parseContinuousRouteLiveResponse(response).discovery.marketEvaluations?.[0]).toMatchObject({ status: "market-only" });

    const unsupported = { kind: "sequence-verified", sequence: 10, protocol: "kucoin-retired-increment" };
    topBook.continuity = unsupported;
    sourceTopBook.continuity = unsupported;
    evidence.protocol = "kucoin-retired-increment";
    evidence.sourceId = `kucoin:public-websocket:${response.activeInstrumentIds[0]}:kucoin-retired-increment:generation-1`;
    (evaluationEvidence.sourceIds as string[])[0] = evidence.sourceId as string;
    expect(() => parseContinuousRouteLiveResponse(response)).toThrow(/protocol/);
  });

  it("parses optional runtime coverage strictly while preserving old-server compatibility", () => {
    expect(parseContinuousRouteLiveResponse(fixture()).coverage).toBeUndefined();
    const current = { ...fixture(), coverage: { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" } };
    expect(parseContinuousRouteLiveResponse(current).coverage).toEqual(current.coverage);
    const stale = { ...fixture(), state: "error", coverage: { complete: false, current: false, retainedPriorDiscovery: true, reason: "refresh-failed" } };
    expect(parseContinuousRouteLiveResponse(stale).coverage).toEqual(stale.coverage);
    expect(() => parseContinuousRouteLiveResponse({ ...fixture(), state: "error", coverage: current.coverage })).toThrow(/coverage is inconsistent/);
    expect(() => parseContinuousRouteLiveResponse({ ...fixture(), state: "error", coverage: { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-invalid" } })).toThrow(/coverage is inconsistent/);
  });

  it("rejects forged execution, foreign active IDs and atomic-snapshot sequence claims", () => {
    expect(() => parseContinuousRouteLiveResponse({ ...fixture(), executable: true })).toThrow(/safety envelope/);
    expect(() => parseContinuousRouteLiveResponse({ ...fixture(), activeInstrumentIds: ["foreign:spot:BTC"] })).toThrow(/allowlist/);
    const forged = fixture();
    forged.discovery.topBooks[0]!.continuity = { kind: "atomic-snapshot", sequenceVerified: true };
    expect(() => parseContinuousRouteLiveResponse(forged)).toThrow(/cannot claim sequence proof/);
  });

  it("accepts strict checksum/observed proofs and rejects upgraded claims", () => {
    const checksum = fixture();
    setContinuity(checksum, { kind: "checksum-verified", sequence: 2, checksum: 3630265277, protocol: "kraken-spot-crc32" });
    expect(parseContinuousRouteLiveResponse(checksum).discovery.topBooks[0]?.continuity).toBe("checksum-verified");

    const observed = fixture();
    setContinuity(observed, { kind: "sequence-observed", sequence: 1004, protocol: "kraken-futures-seq", sequenceVerified: false });
    expect(parseContinuousRouteLiveResponse(observed).discovery.topBooks[0]?.continuity).toBe("sequence-observed");
    setContinuity(observed, { kind: "sequence-observed", sequence: 1005, protocol: "kraken-futures-seq", sequenceVerified: true });
    expect(() => parseContinuousRouteLiveResponse(observed)).toThrow(/cannot claim .*proof/);

    const dydx = fixture();
    setContinuity(dydx, { kind: "sequence-observed", sequence: 42, protocol: "dydx-indexer-message-id", sequenceVerified: false });
    expect(parseContinuousRouteLiveResponse(dydx).discovery.topBooks[0]?.continuity).toBe("sequence-observed");
  });

  it("calls only the public observation endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher });
    await expect(client.continuousRoutes()).resolves.toMatchObject({ state: "live", executable: false });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe("/api/arbitrage/route-families/live");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });
});

function fixture() {
  const first = "okx:spot:BTC-USDT";
  const second = "gate:spot:BTC_USDT";
  const continuity = { kind: "sequence-verified", sequence: 10, protocol: "okx-seqid" };
  return {
    schemaVersion: 1,
    engine: "continuous-route-runtime-v1",
    readOnly: true,
    executionStatus: "research-only",
    executable: false,
    configurationSource: "operator-environment",
    state: "live",
    evaluatedAt: 2_100,
    refreshedAt: 2_000,
    configuredInstrumentIds: [first, second],
    activeInstrumentIds: [first, second],
    unavailable: [],
    discovery: {
      engine: "continuous-route-discovery-v1",
      executionStatus: "research-only",
      executable: false,
      capturedAt: 2_100,
      totalCompatibleCandidates: 1,
      truncated: false,
      candidates: [
        {
          routeKey: JSON.stringify(["cross-venue-spot-spot", first, second]),
          routeId: "rf:cross-venue-spot-spot:9f8981c777e987bff71923f8",
          family: "cross-venue-spot-spot",
          longInstrumentId: first,
          shortInstrumentId: second,
          longMarketType: "spot",
          shortMarketType: "spot",
          economicAssetId: "crypto:bitcoin",
          edgeKind: "research-candidate",
          executable: false
        }
      ],
      instruments: [{ instrumentId: first }, { instrumentId: second }],
      routeReadyBooks: [{ instrumentId: first, quantityUnit: "base", bids: [[100, 2]], asks: [[101, 2]], exchangeTs: 2_000, receivedAt: 2_010, complete: true, sequence: 10, source: "websocket", sourceId: "okx:g1" }],
      topBooks: [{ venue: "okx", instrumentId: first, marketType: "spot", quantityUnit: "base", bid: 100, bidSize: 2, ask: 101, askSize: 2, exchangeTs: 2_000, receivedAt: 2_010, continuity, connectionGeneration: 1 }],
      fundingObservations: [],
      excludedBooks: [],
      rejectedInstruments: [],
      sources: [
        {
          instrument: { venue: "okx", instrumentId: first, venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base" },
          status: { venue: "okx", instrumentId: first, state: "live", message: "book live", generation: 1 },
          book: { venue: "okx", instrumentId: first, venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base", bids: [[100, 2]], asks: [[101, 2]], exchangeTs: 2_000, receivedAt: 2_010, complete: true, continuity, source: "public-websocket", connectionGeneration: 1, retainedDepth: 1 }
        }
      ]
    }
  };
}

function economicsFixture() {
  const base = fixture();
  const longId = base.activeInstrumentIds[0]!;
  const shortId = base.activeInstrumentIds[1]!;
  const candidate = base.discovery.candidates[0]!;
  const longContinuity = { kind: "sequence-verified" as const, sequence: 10, protocol: "okx-seqid" as const };
  const shortContinuity = { kind: "sequence-verified" as const, sequence: 20, protocol: "gate-update-id" as const };
  const longBook = { venue: "okx", instrumentId: longId, marketType: "spot" as const, quantityUnit: "base" as const, bid: 100, bidSize: 2, ask: 101, askSize: 2, exchangeTs: 2_000, receivedAt: 2_010, continuity: longContinuity, connectionGeneration: 1 };
  const shortBook = { venue: "gate", instrumentId: shortId, marketType: "spot" as const, quantityUnit: "base" as const, bid: 103, bidSize: 1.5, ask: 104, askSize: 2, exchangeTs: 2_005, receivedAt: 2_020, continuity: shortContinuity, connectionGeneration: 1 };
  const source = (venue: "okx" | "gate", instrumentId: string, symbol: string, topBook: typeof longBook | typeof shortBook) => ({
    instrument: { venue, instrumentId, venueSymbol: symbol, marketType: "spot" as const, quantityUnit: "base" as const },
    status: { venue, instrumentId, state: "live" as const, message: "book live", generation: 1 },
    topBook
  });
  const identity = { status: "reviewed" as const, source: "test-registry", version: "1", asOf: 1_000, validUntil: 3_000 };
  const instrument = (venue: "okx" | "gate", instrumentId: string, symbol: string) => ({
    instrumentId,
    venue,
    symbol,
    marketType: "spot" as const,
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: identity,
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityModel: { unit: "base" as const },
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    takerFeeBps: 5
  });
  const commonBaseQuantity = 1.5;
  const longNotional = commonBaseQuantity * longBook.ask;
  const shortNotional = commonBaseQuantity * shortBook.bid;
  const referenceNotionalQuote = (longNotional + shortNotional) / 2;
  const grossEntryValueDifferenceQuote = shortNotional - longNotional;
  const longFee = (longNotional * 5) / 10_000;
  const shortFee = (shortNotional * 5) / 10_000;
  const publicEntryFeesQuoteEquivalentEstimate = longFee + shortFee;
  const netEntryValueDifferenceAfterEstimatedFeesQuote = grossEntryValueDifferenceQuote - publicEntryFeesQuoteEquivalentEstimate;
  const bookEvidence = (book: typeof longBook | typeof shortBook) => ({
    sourceId: `${book.venue}:public-websocket:${book.instrumentId}:${book.continuity.protocol}:generation-1`,
    quality: "sequence-verified" as const,
    protocol: book.continuity.protocol,
    sequence: book.continuity.sequence,
    connectionGeneration: 1,
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt
  });
  const leg = (role: "long" | "short", venue: "okx" | "gate", symbol: string, book: typeof longBook | typeof shortBook, notional: number, fee: number) => ({
    role,
    side: role === "long" ? ("buy" as const) : ("sell" as const),
    instrumentId: book.instrumentId,
    venue,
    symbol,
    marketType: "spot" as const,
    quantityUnit: "base" as const,
    price: role === "long" ? book.ask : book.bid,
    topNativeQuantity: role === "long" ? book.askSize : book.bidSize,
    alignedNativeCapacity: role === "long" ? 2 : 1.5,
    usedNativeQuantity: commonBaseQuantity,
    baseQuantity: commonBaseQuantity,
    quoteNotional: notional,
    takerFeeBps: 5,
    publicEntryFeeQuoteEquivalentEstimate: fee,
    feeAssumption: { policyVersion: "continuous-public-taker-fee-v1" as const, source: "operator-environment" as const, accountTierVerified: false as const, discountsApplied: false as const, rebatesApplied: false as const, feeAssetVerified: false as const, exposureImpactIncluded: false as const },
    bookEvidence: bookEvidence(book)
  });
  const longLeg = leg("long", "okx", "BTC-USDT", longBook, longNotional, longFee);
  const shortLeg = leg("short", "gate", "BTC_USDT", shortBook, shortNotional, shortFee);
  return {
    ...base,
    discovery: {
      ...base.discovery,
      instruments: [instrument("okx", longId, "BTC-USDT"), instrument("gate", shortId, "BTC_USDT")],
      topBooks: [longBook, shortBook],
      sources: [source("okx", longId, "BTC-USDT", longBook), source("gate", shortId, "BTC_USDT", shortBook)],
      marketEconomics: {
        engine: "continuous-market-economics-v1" as const,
        readOnly: true as const,
        researchOnly: true as const,
        executable: false as const,
        outcomeClass: "projected" as const,
        evaluatedAt: 2_100,
        totalCandidates: 1,
        evaluatedCandidates: 1,
        marketOnlyCandidates: 1,
        blockedCandidates: 0,
        publishedEvaluations: 1,
        publishedMarketOnlyCandidates: 1,
        publishedBlockedCandidates: 0,
        truncated: false,
        feePolicy: { version: "continuous-public-taker-fee-v1" as const, source: "operator-environment" as const, liquidity: "taker" as const, discountsApplied: false as const, rebatesApplied: false as const, feeAssetVerified: false as const, exposureImpactIncluded: false as const, coverage: "entry-only" as const }
      },
      marketEvaluations: [
        {
          engine: "continuous-market-economics-v1" as const,
          readOnly: true as const,
          researchOnly: true as const,
          executable: false as const,
          outcomeClass: "projected" as const,
          strategyStatus: "blocked" as const,
          evaluatedAt: 2_100,
          routeId: candidate.routeId,
          family: candidate.family,
          longInstrumentId: longId,
          shortInstrumentId: shortId,
          economicAssetId: "crypto:bitcoin",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          executionBoundary: { permission: false as const, orders: "not-supported" as const, reason: "market-data-and-public-entry-fees-only" as const },
          blockedReasons: [
            { code: "account-capital-missing" as const, stage: "strategy-evidence" as const, subject: longId, message: "Verified quote capital is unavailable" },
            { code: "account-inventory-missing" as const, stage: "strategy-evidence" as const, subject: shortId, message: "Verified base inventory is unavailable" },
            { code: "network-rebalance-missing" as const, stage: "strategy-evidence" as const, subject: candidate.routeId, message: "Network rebalance evidence is unavailable" }
          ],
          status: "market-only" as const,
          legs: [longLeg, shortLeg] as const,
          capacity: { scope: "maximum-visible-top-book" as const, matchedBaseQuantity: commonBaseQuantity, commonBaseQuantity, referenceNotionalQuote, longAlignedBaseCapacity: 2, shortAlignedBaseCapacity: 1.5 },
          edges: {
            grossEntryValueDifferenceQuote,
            grossEntryBasisBps: (grossEntryValueDifferenceQuote / referenceNotionalQuote) * 10_000,
            publicEntryFeesQuoteEquivalentEstimate,
            netEntryValueDifferenceAfterEstimatedFeesQuote,
            netEntryBasisAfterEstimatedFeesBps: (netEntryValueDifferenceAfterEstimatedFeesQuote / referenceNotionalQuote) * 10_000,
            coverage: "top-book-entry-and-public-taker-fees-only" as const
          },
          freshness: {
            status: "fresh" as const,
            clockBasis: "calibrated-venue-interval" as const,
            crossVenueComparable: true as const,
            quoteAgeMs: 100,
            legSkewMs: 5,
            maxBookAgeMs: 1_000,
            maxLegSkewMs: 100,
            oldestReceivedAt: 2_010,
            newestReceivedAt: 2_020,
            quoteAgeLowerMs: 100,
            quoteAgeUpperMs: 100,
            minimumPossibleLegSkewMs: 5,
            maximumPossibleLegSkewMs: 5,
            clockLegs: [
              { sourceId: "okx:public", exchangeTs: 2_000, clockStatus: "calibrated" as const, ageLowerMs: 100, ageUpperMs: 100, localEventEarliestAt: 2_000, localEventLatestAt: 2_000 },
              { sourceId: "gate:public", exchangeTs: 2_005, clockStatus: "calibrated" as const, ageLowerMs: 95, ageUpperMs: 95, localEventEarliestAt: 2_005, localEventLatestAt: 2_005 }
            ] as const
          },
          evidence: {
            marketDataComplete: true as const,
            continuityVerified: true as const,
            requiredStrategyEvidenceComplete: false as const,
            sourceIds: [bookEvidence(longBook).sourceId, bookEvidence(shortBook).sourceId] as const,
            economicIdentities: [
              { instrumentId: longId, economicAssetId: "crypto:bitcoin", status: "reviewed" as const, source: "test-registry", version: "1", asOf: 1_000, validUntil: 3_000 },
              { instrumentId: shortId, economicAssetId: "crypto:bitcoin", status: "reviewed" as const, source: "test-registry", version: "1", asOf: 1_000, validUntil: 3_000 }
            ] as const
          }
        }
      ]
    }
  };
}

function blockedEconomicsFixture() {
  const value = economicsFixture();
  const row = value.discovery.marketEvaluations[0] as unknown as Record<string, unknown>;
  row.status = "blocked";
  for (const key of ["legs", "capacity", "edges", "freshness", "evidence"]) delete row[key];
  (row.blockedReasons as Array<Record<string, unknown>>).push({ code: "stale-top-book", stage: "market-data", subject: value.activeInstrumentIds[0], message: "Top book exceeds the freshness boundary" });
  value.discovery.marketEconomics.marketOnlyCandidates = 0;
  value.discovery.marketEconomics.blockedCandidates = 1;
  value.discovery.marketEconomics.publishedMarketOnlyCandidates = 0;
  value.discovery.marketEconomics.publishedBlockedCandidates = 1;
  return value as unknown as Omit<ReturnType<typeof economicsFixture>, "discovery"> & {
    discovery: Omit<ReturnType<typeof economicsFixture>["discovery"], "marketEvaluations"> & { marketEvaluations: Array<Record<string, unknown>> };
  };
}

function checksumEconomicsFixture() {
  const value = economicsFixture();
  const proof = { kind: "checksum-verified", sequence: 10, checksum: 3_630_265_277, protocol: "kraken-spot-crc32" };
  (value.discovery.topBooks[0] as unknown as Record<string, unknown>).continuity = proof;
  (value.discovery.sources[0]!.topBook as unknown as Record<string, unknown>).continuity = proof;
  const evaluation = value.discovery.marketEvaluations[0] as unknown as Record<string, unknown>;
  const longLeg = (evaluation.legs as Array<Record<string, unknown>>)[0]!;
  longLeg.bookEvidence = {
    sourceId: `${value.discovery.topBooks[0]!.venue}:public-websocket:${value.discovery.topBooks[0]!.instrumentId}:kraken-spot-crc32:generation-1`,
    quality: "checksum-verified",
    protocol: "kraken-spot-crc32",
    sequence: 10,
    checksum: 3_630_265_277,
    connectionGeneration: 1,
    exchangeTs: value.discovery.topBooks[0]!.exchangeTs,
    receivedAt: value.discovery.topBooks[0]!.receivedAt
  };
  ((evaluation.evidence as Record<string, unknown>).sourceIds as string[])[0] = (longLeg.bookEvidence as Record<string, unknown>).sourceId as string;
  return value as unknown as Omit<ReturnType<typeof economicsFixture>, "discovery"> & {
    discovery: Omit<ReturnType<typeof economicsFixture>["discovery"], "marketEvaluations"> & { marketEvaluations: Array<Record<string, unknown>> };
  };
}

function setContinuity(value: ReturnType<typeof fixture>, continuity: Record<string, unknown>) {
  value.discovery.topBooks[0]!.continuity = continuity;
  value.discovery.sources[0]!.book.continuity = continuity;
}
