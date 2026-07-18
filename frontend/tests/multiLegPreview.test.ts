import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { describe, expect, it } from "vitest";
import { paperMultiLegSourceFromEnvelope, worstCaseMultiLegCapitalPreview } from "../src/trading/multiLegPreview";

function envelope(overrides: Partial<MarketOpportunityEnvelope> = {}): MarketOpportunityEnvelope {
  return {
    schemaVersion: "market-opportunity-v1",
    id: "preview:fixture",
    family: "spot-dated-future",
    kind: "spread",
    source: { engine: "route-families-v1", opportunityId: "preview-opportunity", evaluatedAt: 1_750_000_000_000 },
    legs: [
      { id: "long", venue: "fixture-a", instrumentId: "fixture-spot", symbol: "BTCUSDT", marketType: "spot", side: "buy", role: "long", identityScope: "canonical-instrument", quantityUnit: "base", quantity: 1, referencePrice: 100 },
      { id: "short", venue: "fixture-b", instrumentId: "fixture-future", symbol: "BTC-FUT", marketType: "future", side: "sell", role: "short", identityScope: "canonical-instrument", quantityUnit: "contract", quantity: 10, referencePrice: 105 }
    ],
    economics: {
      outcome: "research-simulation",
      costCoverage: "entry-public-fees-only",
      entryFees: { value: 0.23, currency: "USDT" },
      funding: "unknown",
      borrow: "unknown",
      slippage: "visible-depth"
    },
    capacity: { notional: { value: 1_150, currency: "USDT" }, depthLimited: false },
    evidence: {
      evaluatedAt: 1_750_000_000_000,
      quoteAgeMs: 20,
      legSkewMs: 1,
      sequenceContinuity: "verified",
      exchangeTimestamps: "verified",
      dataQuality: "fresh",
      sourceIds: ["long", "short"],
      provenanceIds: ["route-families-v1"]
    },
    execution: { research: "available", paperPlan: "ready", live: "blocked", atomicity: "none", paperBlockers: [], liveBlockers: ["Live blocked."] },
    blockers: [],
    ...overrides
  } as MarketOpportunityEnvelope;
}

describe("worst-case multi-leg capital preview", () => {
  it("mirrors the server reservation with a fee reserve for both directions", () => {
    // notional 1·100 + 10·105 = 1150; fee reserve 2·0.23 = 0.46 → 1150.46.
    expect(worstCaseMultiLegCapitalPreview(envelope())).toEqual({
      status: "ready",
      notionalQuote: 1150,
      feeReserveQuote: 0.46,
      worstCaseQuote: 1150.46,
      feeCoverage: "entry-fees"
    });
  });

  it("declares missing numeric fees explicitly instead of showing a silent zero reserve", () => {
    const noFees = envelope();
    (noFees.economics as { entryFees?: unknown }).entryFees = undefined;
    expect(worstCaseMultiLegCapitalPreview(noFees)).toEqual({
      status: "ready",
      notionalQuote: 1150,
      feeReserveQuote: 0,
      worstCaseQuote: 1150,
      feeCoverage: "none"
    });
  });

  it("ceils sub-micro remainders so the preview never under-covers", () => {
    const tiny = envelope({
      legs: [
        { id: "long", venue: "a", instrumentId: "a:spot", symbol: "X", marketType: "spot", side: "buy", role: "long", identityScope: "canonical-instrument", quantityUnit: "base", quantity: 0.0000015, referencePrice: 1 },
        { id: "short", venue: "b", instrumentId: "b:spot", symbol: "X", marketType: "spot", side: "sell", role: "short", identityScope: "canonical-instrument", quantityUnit: "base", quantity: 0.0000015, referencePrice: 1 }
      ]
    });
    (tiny.economics as { entryFees?: unknown }).entryFees = undefined;
    expect(worstCaseMultiLegCapitalPreview(tiny)).toMatchObject({ status: "ready", worstCaseQuote: 0.000003 });
  });

  it("degrades to unavailable when a leg is missing quantity or reference price", () => {
    const missingQuantity = envelope();
    (missingQuantity.legs[0] as { quantity?: number }).quantity = undefined;
    expect(worstCaseMultiLegCapitalPreview(missingQuantity)).toEqual({ status: "unavailable" });

    const missingPrice = envelope();
    (missingPrice.legs[1] as { referencePrice?: number }).referencePrice = undefined;
    expect(worstCaseMultiLegCapitalPreview(missingPrice)).toEqual({ status: "unavailable" });
  });
});

describe("multi-leg source mapping", () => {
  it("maps the n-leg cycle family onto the n-leg source discriminator", () => {
    const nLeg = envelope({ family: "n-leg-cycle" });
    expect(paperMultiLegSourceFromEnvelope(nLeg)).toEqual({
      type: "n-leg",
      opportunity: nLeg as unknown as Record<string, unknown>
    });
  });

  it("maps route families onto the exact server family literals", () => {
    expect(paperMultiLegSourceFromEnvelope(envelope({ family: "spot-spot" }))).toMatchObject({
      type: "route-family",
      family: "cross-venue-spot-spot"
    });
    expect(paperMultiLegSourceFromEnvelope(envelope({ family: "perpetual-perpetual" }))).toMatchObject({
      type: "route-family",
      family: "perpetual-perpetual-funding"
    });
    for (const family of ["reverse-cash-and-carry", "spot-dated-future", "calendar-spread", "perpetual-future"] as const) {
      expect(paperMultiLegSourceFromEnvelope(envelope({ family }))).toMatchObject({ type: "route-family", family });
    }
  });

  it("keeps the run action hidden for families without a fail-closed server builder", () => {
    for (const family of ["cash-and-carry", "dated-futures-spread", "venue-native-spread", "order-book-signal"] as const) {
      expect(paperMultiLegSourceFromEnvelope(envelope({ family }))).toBeUndefined();
    }
  });
});
