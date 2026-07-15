import { describe, expect, it, vi } from "vitest";
import { ArbitrageSdkError, SaltanatArbitrageClient, parsePairwiseEvaluation } from "./index.js";
import type { PairwiseEvaluationRequest } from "./index.js";

describe("public pairwise arbitrage SDK", () => {
  it("posts a research request and strictly validates identity and non-executable output", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage/pairwise/evaluate");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        route: { strategyKind: "spot-spot" },
        instruments: [{ venue: "binance" }, { venue: "bybit" }]
      });
      return json(pairwiseResponseFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });

    await expect(client.pairwise(pairwiseRequestFixture())).resolves.toMatchObject({
      engine: "pairwise-v1",
      executable: false,
      opportunity: { edgeKind: "research-simulation", strategyKind: "spot-spot", executable: false, economicAssetId: "crypto:bitcoin" }
    });
    await expect(client.pairwise(undefined as never)).rejects.toMatchObject<Partial<ArbitrageSdkError>>({ kind: "validation" });

    for (const mutate of [
      (request: PairwiseEvaluationRequest) => {
        (request.instruments[1] as { economicAssetId: string }).economicAssetId = "crypto:wrapped-bitcoin";
      },
      (request: PairwiseEvaluationRequest) => {
        (request.instruments[1] as { economicAssetId: string }).economicAssetId = "bitcoin";
      },
      (request: PairwiseEvaluationRequest) => {
        (request.instruments[1] as Partial<(typeof request.instruments)[1]>).economicIdentity = undefined;
      },
      (request: PairwiseEvaluationRequest) => {
        (request.instruments[1].economicIdentity as { status: string }).status = "unreviewed";
      },
      (request: PairwiseEvaluationRequest) => {
        request.instruments[1].economicIdentity.source = "";
      },
      (request: PairwiseEvaluationRequest) => {
        request.instruments[1].economicIdentity.version = "";
      }
    ]) {
      const request = structuredClone(pairwiseRequestFixture());
      mutate(request);
      await expect(client.pairwise(request)).rejects.toMatchObject<Partial<ArbitrageSdkError>>({ kind: "validation" });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);

    const mismatchedProvenance = pairwiseResponseFixture();
    mismatchedProvenance.opportunity.provenance.metadataIds.reverse();
    expect(() => parsePairwiseEvaluation(mismatchedProvenance)).toThrow(/metadataIds/);
    const mismatchedIdentity = pairwiseResponseFixture();
    mismatchedIdentity.opportunity.economicAssetId = "crypto:wrapped-bitcoin";
    expect(() => parsePairwiseEvaluation(mismatchedIdentity)).toThrow(/economicAssetId must match provenance/);
    const staleIdentity = pairwiseResponseFixture();
    staleIdentity.opportunity.provenance.economicIdentity.legs[1]!.validUntil = 9_999;
    staleIdentity.opportunity.provenance.economicIdentity.legs[1]!.effectiveValidUntil = 9_999;
    expect(() => parsePairwiseEvaluation(staleIdentity)).toThrow(/stale or expired/);
    const futureIdentity = pairwiseResponseFixture();
    futureIdentity.opportunity.provenance.economicIdentity.legs[1]!.asOf = 11_001;
    futureIdentity.opportunity.provenance.economicIdentity.legs[1]!.validUntil = 20_000;
    futureIdentity.opportunity.provenance.economicIdentity.legs[1]!.effectiveValidUntil = 20_000;
    expect(() => parsePairwiseEvaluation(futureIdentity)).toThrow(/future-clock boundary/);
    expect(() => parsePairwiseEvaluation({ ...pairwiseResponseFixture(), rejection: { code: "invalid-route", message: "bad" } })).toThrow(/exactly one/);
    expect(() => parsePairwiseEvaluation({ ...pairwiseResponseFixture(), executable: true })).toThrow(/must be false/);
    expect(() => parsePairwiseEvaluation({ ...pairwiseResponseFixture(), evaluatedAt: 10_001 })).toThrow(/timestamp aggregates/);
    expect(
      parsePairwiseEvaluation({
        engine: "pairwise-v1",
        executable: false,
        evaluatedAt: 10_000,
        rejection: { routeId: "spot-spread", code: "non-profitable", message: "edge below threshold" }
      })
    ).toMatchObject({ executable: false, rejection: { code: "non-profitable" } });
    expect(() =>
      parsePairwiseEvaluation({
        engine: "pairwise-v1",
        executable: false,
        evaluatedAt: 10_000,
        rejection: { code: "order-rejected", message: "bad" }
      })
    ).toThrow(/rejection.code/);

    const negativeResidual = pairwiseResponseFixture();
    negativeResidual.opportunity.executableBaseQuantity = 0.99995;
    negativeResidual.opportunity.longBaseQuantity = 0.99995;
    negativeResidual.opportunity.residualBaseQuantity = -0.00005;
    negativeResidual.opportunity.unfilledBaseQuantity = 0.00005;
    negativeResidual.opportunity.baseDustQuantity = 0.00005;
    negativeResidual.opportunity.legs[0]!.baseEquivalentQuantity = 0.99995;
    negativeResidual.opportunity.legs[0]!.quoteNotional = 99.995;
    negativeResidual.opportunity.legs[0]!.entryFeeQuote = 0.099995;
    negativeResidual.opportunity.grossEntryPnlQuote = 4.005;
    negativeResidual.opportunity.referenceNotionalQuote = 101.9975;
    negativeResidual.opportunity.costs.entryFeesQuote = 0.203995;
    negativeResidual.opportunity.grossExpectedPnlQuote = 4.005;
    negativeResidual.opportunity.netExpectedPnlQuote = 3.751005;
    negativeResidual.opportunity.entryBasisBps = (4.005 / 101.9975) * 10_000;
    negativeResidual.opportunity.netReturnBps = (3.751005 / 101.9975) * 10_000;
    expect(parsePairwiseEvaluation(negativeResidual).opportunity).toMatchObject({ residualBaseQuantity: -0.00005 });
  });

  it("rejects forged pairwise timestamp, residual, cost and PnL identities", () => {
    const cases: Array<(fixture: ReturnType<typeof pairwiseResponseFixture>) => void> = [
      (fixture) => {
        fixture.opportunity.id = "pairwise:forged";
      },
      (fixture) => {
        fixture.opportunity.provenance.books[0]!.receivedAt += 1;
      },
      (fixture) => {
        fixture.opportunity.timestamps.oldestExchangeTs += 1;
      },
      (fixture) => {
        fixture.opportunity.timestamps.quoteAgeMs = 0;
      },
      (fixture) => {
        fixture.opportunity.timestamps.oldestAssumptionAsOf += 1;
      },
      (fixture) => {
        fixture.opportunity.longBaseQuantity = 0.9;
      },
      (fixture) => {
        fixture.opportunity.executableBaseQuantity = 0.9;
      },
      (fixture) => {
        fixture.opportunity.residualBaseQuantity = 0.1;
      },
      (fixture) => {
        fixture.opportunity.unfilledBaseQuantity = 0.1;
      },
      (fixture) => {
        fixture.opportunity.capacityShortfallBaseQuantity = 0.1;
      },
      (fixture) => {
        fixture.opportunity.legs[0]!.averagePrice = 99;
      },
      (fixture) => {
        fixture.opportunity.legs[1]!.worstPrice = 105;
      },
      (fixture) => {
        fixture.opportunity.referenceNotionalQuote = 100;
      },
      (fixture) => {
        fixture.opportunity.grossEntryPnlQuote = 5;
      },
      (fixture) => {
        fixture.opportunity.grossExpectedPnlQuote = 5;
      },
      (fixture) => {
        fixture.opportunity.legs[0]!.entryFeeQuote = 0.2;
      },
      (fixture) => {
        fixture.opportunity.costs.entryFeesQuote = 0.3;
      },
      (fixture) => {
        fixture.opportunity.netExpectedPnlQuote = 3;
      },
      (fixture) => {
        fixture.opportunity.entryBasisBps = 400;
      },
      (fixture) => {
        fixture.opportunity.netReturnBps = 300;
      }
    ];
    for (const mutate of cases) {
      const fixture = pairwiseResponseFixture();
      mutate(fixture);
      expect(() => parsePairwiseEvaluation(fixture)).toThrow();
    }
  });
});

function pairwiseRequestFixture(): PairwiseEvaluationRequest {
  const identity = { status: "reviewed" as const, source: "sdk-reviewed-map", version: "2026-07-14", asOf: 9_800, validUntil: 86_410_000 };
  const instruments: PairwiseEvaluationRequest["instruments"] = [
    {
      instrumentId: "binance:spot:BTCUSDT",
      venue: "binance",
      symbol: "BTCUSDT",
      marketType: "spot",
      baseAsset: "BTC",
      economicAssetId: "crypto:bitcoin",
      economicIdentity: { ...identity },
      quoteAsset: "USDT",
      settleAsset: "USDT",
      quantityModel: { unit: "base" },
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 10,
      takerFeeBps: 10
    },
    {
      instrumentId: "bybit:spot:BTCUSDT",
      venue: "bybit",
      symbol: "BTCUSDT",
      marketType: "spot",
      baseAsset: "BTC",
      economicAssetId: "crypto:bitcoin",
      economicIdentity: { ...identity },
      quoteAsset: "USDT",
      settleAsset: "USDT",
      quantityModel: { unit: "base" },
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 10,
      takerFeeBps: 10
    }
  ];
  const books: PairwiseEvaluationRequest["books"] = [
    { instrumentId: instruments[0].instrumentId, quantityUnit: "base", bids: [[99, 10]], asks: [[100, 10]], exchangeTs: 9_985, receivedAt: 9_995, complete: true, sequence: 1, source: "fixture", sourceId: "fixture:binance" },
    { instrumentId: instruments[1].instrumentId, quantityUnit: "base", bids: [[104, 10]], asks: [[105, 10]], exchangeTs: 9_987, receivedAt: 9_997, complete: true, sequence: 2, source: "fixture", sourceId: "fixture:bybit" }
  ];
  return {
    instruments,
    books,
    route: {
      routeId: "spot-spread",
      strategyKind: "spot-spot",
      longInstrumentId: instruments[0].instrumentId,
      shortInstrumentId: instruments[1].instrumentId,
      requestedBaseQuantity: 1,
      longCapital: { kind: "capital", availableQuoteQuantity: 1_000, availabilityVerified: true, source: "manual-prefund", asOf: 9_800 },
      shortAccess: { kind: "inventory", availableBaseQuantity: 1, availabilityVerified: true, source: "manual-prefund", asOf: 9_800 },
      rebalance: { costBps: 5, source: "manual-rebalance", asOf: 9_800 }
    }
  };
}

function pairwiseResponseFixture() {
  const longId = "binance:spot:BTCUSDT";
  const shortId = "bybit:spot:BTCUSDT";
  const identity = { status: "reviewed", source: "sdk-reviewed-map", version: "2026-07-14", asOf: 9_800, validUntil: 86_410_000, effectiveValidUntil: 86_410_000 };
  const leg = (role: "long" | "short", instrumentId: string, venue: string, price: number, exchangeTs: number, receivedAt: number) => ({
    role,
    instrumentId,
    venue,
    symbol: "BTCUSDT",
    marketType: "spot",
    side: role === "long" ? "buy" : "sell",
    bookSide: role === "long" ? "asks" : "bids",
    nativeQuantity: 1,
    quantityUnit: "base",
    baseEquivalentQuantity: 1,
    averagePrice: price,
    worstPrice: price,
    quoteNotional: price,
    entryFeeBps: 10,
    entryFeeQuote: price / 1_000,
    levelsUsed: 1,
    depthLimited: false,
    exchangeTs,
    receivedAt
  });
  return {
    engine: "pairwise-v1",
    executable: false,
    evaluatedAt: 10_000,
    opportunity: {
      id: "pairwise:spot-spread",
      strategyKind: "spot-spot",
      edgeKind: "research-simulation",
      executable: false,
      routeId: "spot-spread",
      baseAsset: "BTC",
      economicAssetId: "crypto:bitcoin",
      quoteAsset: "USDT",
      requestedBaseQuantity: 1,
      executableBaseQuantity: 1,
      longBaseQuantity: 1,
      shortBaseQuantity: 1,
      residualBaseQuantity: 0,
      unfilledBaseQuantity: 0,
      capacityShortfallBaseQuantity: 0,
      baseDustQuantity: 0,
      grossEntryPnlQuote: 4,
      grossExpectedPnlQuote: 4,
      netExpectedPnlQuote: 3.746,
      entryBasisBps: 392.156862745098,
      expectedExitBasisBps: 0,
      netReturnBps: 367.2549019607843,
      referenceNotionalQuote: 102,
      legs: [leg("long", longId, "binance", 100, 9_985, 9_995), leg("short", shortId, "bybit", 104, 9_987, 9_997)],
      costs: { entryFeesQuote: 0.204, exitFeesQuote: 0, borrowCostQuote: 0, fundingNetQuote: 0, deliveryFeesQuote: 0, rebalanceCostQuote: 0.05 },
      timestamps: { evaluatedAt: 10_000, oldestExchangeTs: 9_985, newestExchangeTs: 9_987, oldestReceivedAt: 9_995, newestReceivedAt: 9_997, quoteAgeMs: 15, legSkewMs: 2, oldestAssumptionAsOf: 9_800, assumptionAgeMs: 200 },
      provenance: {
        engine: "pairwise-v1",
        routeId: "spot-spread",
        metadataIds: [longId, shortId],
        economicIdentity: {
          economicAssetId: "crypto:bitcoin",
          matchPolicy: "exact",
          authority: "caller-supplied",
          maxAgeMs: 2_592_000_000,
          maxFutureClockSkewMs: 1_000,
          legs: [
            { instrumentId: longId, ...identity },
            { instrumentId: shortId, ...identity }
          ]
        },
        books: [
          { instrumentId: longId, source: "fixture", sourceId: "fixture:binance", sequence: 1, exchangeTs: 9_985, receivedAt: 9_995 },
          { instrumentId: shortId, source: "fixture", sourceId: "fixture:bybit", sequence: 2, exchangeTs: 9_987, receivedAt: 9_997 }
        ],
        assumptions: [
          { kind: "inventory", source: "manual-prefund", asOf: 9_800 },
          { kind: "rebalance", source: "manual-rebalance", asOf: 9_800 }
        ]
      },
      riskFlags: ["simultaneous-execution-not-guaranteed", "caller-supplied-identity-review", "prefunded-spot-inventory", "cross-venue-rebalance"]
    }
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
