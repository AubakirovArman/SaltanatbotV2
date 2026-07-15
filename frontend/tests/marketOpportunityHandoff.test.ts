// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArbitrageOpportunity } from "../src/arbitrage/client";
import { OpportunityHandoffButton } from "../src/arbitrage/OpportunityHandoffButton";
import {
  adaptBasisOpportunity,
  adaptNativeSpreadOpportunity,
  adaptTriangularOpportunity
} from "../src/arbitrage/marketOpportunityAdapters";
import {
  consumeMarketOpportunityHandoff,
  handoffMarketOpportunity,
  MARKET_OPPORTUNITY_HANDOFF_EVENT,
  MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES,
  MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY,
  readMarketOpportunityHandoff,
  type MarketOpportunityHandoffRecord
} from "../src/arbitrage/marketOpportunityHandoff";
import type { NativeSpreadOpportunity } from "../src/arbitrage/nativeSpreadClient";
import { NativeSpreadRow } from "../src/arbitrage/NativeSpreadScreener";
import type { TriangularOpportunity } from "../src/arbitrage/triangularClient";
import { basisDisplayedScenario, DEFAULT_FEE_PROFILE } from "../src/arbitrage/fees";

beforeEach(() => sessionStorage.clear());

describe("market opportunity adapters", () => {
  it("keeps basis research-only and preserves projected economics", () => {
    const envelope = adaptBasisOpportunity(BASIS);
    expect(envelope).toMatchObject({
      schemaVersion: "market-opportunity-v1",
      family: "cash-and-carry",
      economics: { netEdgeBps: 180, expectedNetProfit: { value: 18, currency: "USD" } },
      execution: { paperPlan: "unsupported", live: "blocked", atomicity: "none" }
    });
    expect(envelope.legs.map((leg) => leg.side)).toEqual(["buy", "sell"]);
  });

  it("binds the handoff to the exact displayed custom-cost scenario", () => {
    const profile = { ...DEFAULT_FEE_PROFILE, transferCostUsd: 100, expectedHoldingHours: 24, annualBorrowRatePct: 12 };
    const displayed = basisDisplayedScenario(BASIS, profile, 250, BASIS.capturedAt);
    const envelope = adaptBasisOpportunity(BASIS, displayed);

    expect(BASIS.netEdgeBps).toBeGreaterThan(0);
    expect(displayed.netEdgeBps).toBeLessThan(0);
    expect(envelope.economics).toMatchObject({
      netEdgeBps: displayed.netEdgeBps,
      expectedNetProfit: { value: displayed.projectedNetProfitUsd, currency: "USD" },
      aggregateEstimatedCostBps: displayed.basisScenario.costBreakdownBps.total,
      basisScenario: displayed.basisScenario
    });
    expect(envelope.capacity.notional?.value).toBe(displayed.basisScenario.executableNotionalUsd);
    expect(envelope.capacity.quantity).toBe(2.5);
    expect(envelope.legs.map((leg) => leg.quantity)).toEqual([2.5, 2.5]);

    const record = handoffMarketOpportunity(envelope, { storage: sessionStorage, now: 1_000, ttlMs: 5_000 });
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })?.opportunity).toEqual(record.opportunity);
  });

  it("keeps an unsequenced triangular REST row blocked from paper and live execution", () => {
    const envelope = adaptTriangularOpportunity(TRIANGULAR);
    expect(envelope).toMatchObject({
      family: "n-leg-cycle",
      source: { engine: "triangular-rest-top-book-v1" },
      evidence: { sequenceContinuity: "unverified", dataQuality: "unverified" },
      execution: { paperPlan: "blocked", live: "blocked" }
    });
    expect(envelope.legs).toHaveLength(3);
    expect(envelope.blockers.map((blocker) => blocker.code)).toContain("unsequenced-rest-top-book");
  });

  it("keeps native-spread component sides derived until an explicit venue action exists", () => {
    const envelope = adaptNativeSpreadOpportunity(NATIVE_SPREAD, { evaluatedAt: 1_000, now: 1_001 });
    expect(envelope).toMatchObject({
      family: "venue-native-spread",
      economics: {
        outcome: "two-sided-quote",
        twoSidedQuote: { bidPrice: 10, askPrice: 11, absoluteWidth: 1, priceUnit: "USDT" }
      },
      capacity: { quantity: 2, quantityUnit: "base", quantityAsset: "BTC" },
      execution: { paperPlan: "blocked", live: "blocked", atomicity: "venue-native" }
    });
    expect(envelope.legs.map((leg) => leg.side)).toEqual(["derived", "derived"]);
    expect(envelope.legs.map((leg) => [leg.quantityUnit, leg.quantityAsset])).toEqual([
      ["base", "BTC"],
      ["base", "BTC"]
    ]);
    handoffMarketOpportunity(envelope, { storage: sessionStorage, now: 1_000, ttlMs: 5_000 });
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })?.opportunity).toMatchObject({
      economics: { twoSidedQuote: { bidPrice: 10, askPrice: 11, absoluteWidth: 1, priceUnit: "USDT" } },
      capacity: { quantityAsset: "BTC" }
    });

    const stale = adaptNativeSpreadOpportunity(NATIVE_SPREAD, { evaluatedAt: 1_000, now: 11_001 });
    expect(stale.evidence.dataQuality).toBe("stale");
    expect(stale.blockers.map((blocker) => blocker.code)).toContain("native-spread-quote-stale");
  });

  it("disables native handoff when the single render clock expires the quote", () => {
    const html = renderToStaticMarkup(
      createElement(NativeSpreadRow, {
        locale: "en",
        row: NATIVE_SPREAD,
        evaluatedAt: 1_000,
        now: 11_001,
        columns: new Set(["quality", "actions"]),
        onOpenChart: () => undefined
      })
    );
    expect(html).toContain("age 10011 ms");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Refresh this stale native spread quote before transferring it.");
  });
});

describe("market opportunity session handoff", () => {
  it("renders a localized accessible research action", () => {
    const html = renderToStaticMarkup(
      createElement(OpportunityHandoffButton, {
        locale: "ru",
        name: "BTCUSDT",
        createOpportunity: () => adaptBasisOpportunity(BASIS)
      })
    );
    expect(html).toContain('type="button"');
    expect(html).toContain("Передать BTCUSDT в автоматизацию для исследования");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("stores a bounded record and dispatches typed same-tab detail", () => {
    let detail: MarketOpportunityHandoffRecord | undefined;
    window.addEventListener(
      MARKET_OPPORTUNITY_HANDOFF_EVENT,
      (event) => {
        detail = (event as CustomEvent<MarketOpportunityHandoffRecord>).detail;
      },
      { once: true }
    );
    const envelope = adaptBasisOpportunity(BASIS);
    const record = handoffMarketOpportunity(envelope, { storage: sessionStorage, eventTarget: window, now: 1_000, ttlMs: 5_000 });

    expect(detail).toEqual(record);
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })).toEqual(record);
    expect(sessionStorage.getItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY)?.length).toBeLessThan(MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES);
  });

  it("consumes once and cleans expired records", () => {
    handoffMarketOpportunity(adaptTriangularOpportunity(TRIANGULAR), { storage: sessionStorage, now: 1_000, ttlMs: 5_000 });
    expect(consumeMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })?.opportunity.id).toBe(TRIANGULAR.id);
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })).toBeNull();

    handoffMarketOpportunity(adaptBasisOpportunity(BASIS), { storage: sessionStorage, now: 10_000, ttlMs: 2_000 });
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 12_000 })).toBeNull();
    expect(sessionStorage.getItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it("fails closed on tampered paper readiness and oversized input", () => {
    const record = handoffMarketOpportunity(adaptBasisOpportunity(BASIS), { storage: sessionStorage, now: 1_000, ttlMs: 5_000 });
    sessionStorage.setItem(
      MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        ...record,
        opportunity: {
          ...record.opportunity,
          evidence: { ...record.opportunity.evidence, sequenceContinuity: "verified", exchangeTimestamps: "verified" },
          execution: { ...record.opportunity.execution, paperPlan: "ready", paperBlockers: [] }
        }
      })
    );
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })).toBeNull();
    expect(sessionStorage.getItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY)).toBeNull();

    sessionStorage.setItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY, "x".repeat(MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES + 1));
    expect(readMarketOpportunityHandoff({ storage: sessionStorage, now: 2_000 })).toBeNull();
    expect(sessionStorage.getItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY)).toBeNull();
  });
});

const BASIS: ArbitrageOpportunity = {
  id: "BTCUSDT:binance:bybit",
  strategyKind: "cash-and-carry",
  edgeKind: "projected",
  identityScope: "cross-venue-reviewed",
  symbol: "BTCUSDT",
  assetId: "crypto:bitcoin",
  spotInstrumentId: "binance:spot:BTCUSDT",
  futuresInstrumentId: "bybit:perpetual:BTCUSDT",
  spotExchange: "binance",
  futuresExchange: "bybit",
  spotBid: 99,
  spotAsk: 100,
  spotAskSize: 10,
  futuresBid: 102,
  futuresAsk: 103,
  futuresBidSize: 10,
  grossSpreadBps: 200,
  estimatedTotalCostBps: 20,
  netEdgeBps: 180,
  topBookCapacityUsd: 1_000,
  topBookMatchedQuantity: 10,
  expectedNetProfitUsd: 18,
  fundingRate: 0.0001,
  fundingScheduleVerified: true,
  fundingIntervalMinutes: 480,
  nextFundingTime: 2_000,
  spotExchangeTs: 900,
  spotExchangeTimestampVerified: true,
  spotReceivedAt: 950,
  futuresExchangeTs: 910,
  futuresExchangeTimestampVerified: true,
  futuresReceivedAt: 960,
  quoteAgeMs: 100,
  legSkewMs: 10,
  dataQuality: "fresh",
  capturedAt: 1_000
};

const TRIANGULAR: TriangularOpportunity = {
  id: "binance:USDT-BTC-ETH-USDT",
  edgeKind: "non-executable-candidate",
  executionStatus: "non-executable-candidate",
  marketDataMode: "rest-top-book",
  sequenceVerified: false,
  venue: "binance",
  startAsset: "USDT",
  startQuantity: 1_000,
  endQuantity: 1_003,
  grossReturnBps: 60,
  netReturnBps: 30,
  limitingCapacity: { requestedStartQuantity: 1_000, executableStartQuantity: 1_000, utilizationPct: 100 },
  legs: [
    { index: 0, symbol: "BTCUSDT", side: "buy", fromAsset: "USDT", toAsset: "BTC", inputQuantity: 1_000, outputQuantity: 0.01, averagePrice: 100_000, feeBps: 10, levelsUsed: 1 },
    { index: 1, symbol: "ETHBTC", side: "buy", fromAsset: "BTC", toAsset: "ETH", inputQuantity: 0.01, outputQuantity: 0.2, averagePrice: 0.05, feeBps: 10, levelsUsed: 1 },
    { index: 2, symbol: "ETHUSDT", side: "sell", fromAsset: "ETH", toAsset: "USDT", inputQuantity: 0.2, outputQuantity: 1_003, averagePrice: 5_015, feeBps: 10, levelsUsed: 1 }
  ],
  timestamps: { evaluatedAt: 1_000, quoteAgeMs: 80, legSkewMs: 20, exchangeTimestampsVerified: true },
  riskFlags: ["top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]
};

const NATIVE_SPREAD: NativeSpreadOpportunity = {
  id: "bybit:native-spread:BTCUSDT-ETHUSDT",
  venue: "bybit",
  symbol: "BTCUSDT-ETHUSDT",
  contractType: "PerpBasis",
  status: "Trading",
  baseCoin: "BTC",
  quoteCoin: "USDT",
  settleCoin: "USDT",
  tickSize: 0.1,
  minimumPrice: -10_000,
  maximumPrice: 10_000,
  quantityStep: 0.001,
  minimumQuantity: 0.001,
  maximumQuantity: 100,
  launchTime: 1,
  legs: [
    { symbol: "BTCUSDT", contractType: "LinearPerpetual" },
    { symbol: "ETHUSDT", contractType: "LinearFutures" }
  ],
  bidPrice: 10,
  bidQuantity: 2,
  askPrice: 11,
  askQuantity: 3,
  bookWidth: 1,
  relativeBookWidthBps: 952.3809523809523,
  executableQuantity: 2,
  sequence: 7,
  exchangeTs: 990,
  matchingEngineTs: 980,
  receivedAt: 1_000,
  quoteAgeMs: 10,
  riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
};
