// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContinuousRouteLiveResponse } from "../src/arbitrage/continuousRoutes";
import { continuousBlockReasonText } from "../src/arbitrage/continuousRoutesText";
import { ContinuousRoutesView } from "../src/arbitrage/ContinuousRoutesPanel";
import { adaptContinuousMarketOpportunity } from "../src/arbitrage/marketOpportunityAdapters";

describe("ContinuousRoutesView", () => {
  it("renders read-only source health and route identity in Russian", () => {
    const html = renderToStaticMarkup(<ContinuousRoutesView locale="ru" snapshot={fixture()} />);
    expect(html).toContain("Непрерывные межбиржевые маршруты");
    expect(html).toContain("полная и актуальная");
    expect(html).toContain("только для чтения");
    expect(html).toContain("okx:spot:BTC-USDT");
    expect(html).toContain("cross-venue-spot-spot");
    expect(html).toContain("crypto:bitcoin");
    expect(html).toContain("Наблюдаемая рыночная экономика");
    expect(html).toContain("максимальная видимая ёмкость");
    expect(html).toContain("Basis входа после оценочных комиссий");
    expect(html).toContain("актив комиссии и влияние на экспозицию не подтверждены");
    expect(html).toContain("operator-review");
    expect(html).toContain("калиброванный интервал времени биржи");
    expect(html).toContain("нет подтверждённого капитала на счёте");
    expect(html).toContain("ордера запрещены");
    expect(html).toContain("Передать cross-venue-spot-spot");
    expect(html).not.toContain("Выставить ордер");

    const evaluation = fixture().discovery.marketEvaluations?.[0];
    if (!evaluation) throw new Error("fixture evaluation is missing");
    expect(adaptContinuousMarketOpportunity(evaluation)).toMatchObject({
      family: "spot-spot",
      evidence: { sequenceContinuity: "verified" },
      execution: { paperPlan: "blocked", live: "blocked" }
    });
  });

  it("renders the market-only boundary and blockers in Kazakh", () => {
    const html = renderToStaticMarkup(<ContinuousRoutesView locale="kk" snapshot={fixture()} />);
    expect(html).toContain("Бақыланатын нарық экономикасы");
    expect(html).toContain("стакан төбесінде көрінетін ең жоғары сыйымдылық");
    expect(html).toContain("Бағаланған комиссиядан кейінгі кіру basis-і");
    expect(html).toContain("комиссия активі мен экспозицияға әсері расталмаған");
    expect(html).toContain("биржа уақытының калибрленген аралығы");
    expect(html).toContain("шоттағы расталған капитал жоқ");
    expect(html).toContain("ордерлерге рұқсат жоқ");
    expect(html).not.toContain("Ордер жіберу");
  });

  it("explains disabled state in Kazakh without inventing subscriptions", () => {
    const snapshot = fixture();
    snapshot.state = "disabled";
    snapshot.coverage = { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-disabled" };
    snapshot.configuredInstrumentIds = [];
    snapshot.activeInstrumentIds = [];
    snapshot.discovery.sources = [];
    snapshot.discovery.candidates = [];
    snapshot.discovery.totalCompatibleCandidates = 0;
    snapshot.discovery.routeReadyBookCount = 0;
    snapshot.discovery.marketEconomics = undefined;
    snapshot.discovery.marketEvaluations = undefined;
    const html = renderToStaticMarkup(<ContinuousRoutesView locale="kk" snapshot={snapshot} />);
    expect(html).toContain("ARBITRAGE_CONTINUOUS_ROUTES_JSON");
    expect(html).toContain("WebSocket жазылымдары іске қосылмады");
  });

  it("expires retained market rows from the render clock and disables handoff", () => {
    const snapshot = fixture();
    snapshot.coverage = { complete: false, current: false, retainedPriorDiscovery: true, reason: "refresh-failed" };
    const html = renderToStaticMarkup(<ContinuousRoutesView locale="en" snapshot={snapshot} now={12_101} error="refresh failed" />);
    expect(html).toContain("showing the last successful discovery snapshot");
    expect(html).toContain("age 10,012 ms");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Refresh this non-current or stale route before transferring it.");

    const evaluation = snapshot.discovery.marketEvaluations?.[0];
    if (!evaluation) throw new Error("fixture evaluation is missing");
    const envelope = adaptContinuousMarketOpportunity(evaluation, { now: 12_101, sourceCurrent: false });
    expect(envelope.evidence.dataQuality).toBe("stale");
    expect(envelope.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["continuous-source-not-current", "continuous-quote-stale"]));
  });

  it.each(["en", "ru", "kk"] as const)("renders every typed clock blocker as visible %s text", (locale) => {
    const codes = ["clock-unavailable", "clock-not-calibrated", "timestamp-definitely-future", "timestamp-may-be-future", "timestamp-stale", "clock-skew-exceeded"] as const;
    for (const code of codes) {
      const snapshot = fixture();
      const evaluation = snapshot.discovery.marketEvaluations?.[0] as unknown as Record<string, unknown>;
      evaluation.status = "blocked";
      evaluation.blockedReasons = [{ code, stage: "market-data", subject: "clock", message: code }];
      for (const field of ["legs", "capacity", "edges", "freshness", "evidence"]) delete evaluation[field];
      snapshot.discovery.marketEconomics!.marketOnlyCandidates = 0;
      snapshot.discovery.marketEconomics!.blockedCandidates = 1;
      snapshot.discovery.marketEconomics!.publishedMarketOnlyCandidates = 0;
      snapshot.discovery.marketEconomics!.publishedBlockedCandidates = 1;
      const html = renderToStaticMarkup(<ContinuousRoutesView locale={locale} snapshot={snapshot} />);
      expect(html).toContain(continuousBlockReasonText(locale, code));
    }
  });
});

function fixture(): ContinuousRouteLiveResponse {
  const first = "okx:spot:BTC-USDT";
  const second = "gate:spot:BTC_USDT";
  return {
    schemaVersion: 1,
    engine: "continuous-route-runtime-v1",
    readOnly: true,
    executionStatus: "research-only",
    executable: false,
    configurationSource: "operator-environment",
    state: "live",
    coverage: { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" },
    evaluatedAt: 2_100,
    refreshedAt: 2_000,
    configuredInstrumentIds: [first, second],
    activeInstrumentIds: [first, second],
    unavailable: [],
    discovery: {
      engine: "continuous-route-discovery-v1",
      capturedAt: 2_100,
      totalCompatibleCandidates: 1,
      truncated: false,
      routeReadyBookCount: 1,
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
      marketEconomics: {
        engine: "continuous-market-economics-v1",
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        evaluatedAt: 2_100,
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
      },
      marketEvaluations: [
        {
          engine: "continuous-market-economics-v1",
          readOnly: true,
          researchOnly: true,
          executable: false,
          outcomeClass: "projected",
          strategyStatus: "blocked",
          evaluatedAt: 2_100,
          routeId: "rf:cross-venue-spot-spot:9f8981c777e987bff71923f8",
          family: "cross-venue-spot-spot",
          longInstrumentId: first,
          shortInstrumentId: second,
          economicAssetId: "crypto:bitcoin",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          executionBoundary: { permission: false, orders: "not-supported", reason: "market-data-and-public-entry-fees-only" },
          status: "market-only",
          blockedReasons: [
            { code: "account-capital-missing", stage: "strategy-evidence", subject: first, message: "missing capital" },
            { code: "account-inventory-missing", stage: "strategy-evidence", subject: second, message: "missing inventory" },
            { code: "network-rebalance-missing", stage: "strategy-evidence", subject: "rf:cross-venue-spot-spot:9f8981c777e987bff71923f8", message: "missing rebalance" }
          ],
          legs: [marketLeg("long", "buy", "okx", "BTC-USDT", first, 100, 200, 0.1, 2_090), marketLeg("short", "sell", "gate", "BTC_USDT", second, 102, 204, 0.102, 2_092)],
          capacity: {
            scope: "maximum-visible-top-book",
            matchedBaseQuantity: 2,
            commonBaseQuantity: 2,
            referenceNotionalQuote: 202,
            longAlignedBaseCapacity: 2,
            shortAlignedBaseCapacity: 2
          },
          edges: {
            grossEntryValueDifferenceQuote: 4,
            grossEntryBasisBps: (4 / 202) * 10_000,
            publicEntryFeesQuoteEquivalentEstimate: 0.202,
            netEntryValueDifferenceAfterEstimatedFeesQuote: 3.798,
            netEntryBasisAfterEstimatedFeesBps: (3.798 / 202) * 10_000,
            coverage: "top-book-entry-and-public-taker-fees-only"
          },
          freshness: {
            status: "fresh",
            clockBasis: "calibrated-venue-interval",
            crossVenueComparable: true,
            quoteAgeMs: 11,
            legSkewMs: 2,
            maxBookAgeMs: 10_000,
            maxLegSkewMs: 1_000,
            oldestReceivedAt: 2_090,
            newestReceivedAt: 2_092,
            quoteAgeLowerMs: 11,
            quoteAgeUpperMs: 11,
            minimumPossibleLegSkewMs: 2,
            maximumPossibleLegSkewMs: 2,
            clockLegs: [
              { sourceId: "okx:public", exchangeTs: 2_089, clockStatus: "calibrated", ageLowerMs: 11, ageUpperMs: 11, localEventEarliestAt: 2_089, localEventLatestAt: 2_089 },
              { sourceId: "gate:public", exchangeTs: 2_091, clockStatus: "calibrated", ageLowerMs: 9, ageUpperMs: 9, localEventEarliestAt: 2_091, localEventLatestAt: 2_091 }
            ]
          },
          evidence: {
            marketDataComplete: true,
            continuityVerified: true,
            requiredStrategyEvidenceComplete: false,
            sourceIds: ["okx:g1", "gate:g1"],
            economicIdentities: [
              { instrumentId: first, economicAssetId: "crypto:bitcoin", status: "reviewed", source: "operator-review", version: "registry-v1", asOf: 1_000, validUntil: 3_000 },
              { instrumentId: second, economicAssetId: "crypto:bitcoin", status: "reviewed", source: "operator-review", version: "registry-v1", asOf: 1_000, validUntil: 3_000 }
            ]
          }
        }
      ],
      topBooks: [],
      fundingObservations: [],
      excludedBooks: [],
      rejectedInstruments: [],
      sources: [
        { venue: "okx", instrumentId: first, marketType: "spot", state: "live", message: "book live", generation: 1, hasBook: true, hasTopBook: true, hasFunding: false },
        { venue: "gate", instrumentId: second, marketType: "spot", state: "live", message: "book live", generation: 1, hasBook: true, hasTopBook: true, hasFunding: false }
      ]
    }
  };
}

function marketLeg(role: "long" | "short", side: "buy" | "sell", venue: string, symbol: string, instrumentId: string, price: number, quoteNotional: number, publicEntryFeeQuoteEquivalentEstimate: number, receivedAt: number) {
  return {
    role,
    side,
    instrumentId,
    venue,
    symbol,
    marketType: "spot" as const,
    quantityUnit: "base" as const,
    price,
    topNativeQuantity: 2,
    alignedNativeCapacity: 2,
    usedNativeQuantity: 2,
    baseQuantity: 2,
    quoteNotional,
    takerFeeBps: 5,
    publicEntryFeeQuoteEquivalentEstimate,
    feeAssumption: {
      policyVersion: "continuous-public-taker-fee-v1" as const,
      source: "operator-environment" as const,
      accountTierVerified: false as const,
      discountsApplied: false as const,
      rebatesApplied: false as const,
      feeAssetVerified: false as const,
      exposureImpactIncluded: false as const
    },
    bookEvidence: { sourceId: `${venue}:g1`, quality: "sequence-verified" as const, protocol: venue === "okx" ? "okx-seqid" : "gate-update-id", sequence: 10, connectionGeneration: 1, exchangeTs: receivedAt - 1, receivedAt }
  };
}
