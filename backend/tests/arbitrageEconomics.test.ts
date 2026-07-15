import { describe, expect, it } from "vitest";
import { evaluateRouteEconomics, type RouteEconomicsRequest, type VersionedEvidence } from "../src/arbitrage/economics/index.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const evidence = (source: string, validUntil = NOW + 2 * HOUR): VersionedEvidence => ({ source, version: "v1", asOf: NOW - 1_000, validUntil });

function request(): RouteEconomicsRequest {
  return {
    routeId: "BTC-basis",
    evaluatedAt: NOW,
    horizonStart: NOW,
    horizonEnd: NOW + HOUR,
    valuationAsset: "USDT",
    maximumEvidenceAgeMs: 60_000,
    maximumFutureClockSkewMs: 1_000,
    maximumTransferArrivalMs: 30 * 60_000,
    execution: {
      requestedBaseQuantity: 1,
      executableBaseQuantity: 1,
      residualBaseQuantity: 0,
      maximumResidualBps: 1,
      atomicity: "independent-venues",
      observedLegSkewMs: 10,
      maximumLeggingMs: 500
    },
    settlement: { kind: "convergence-assumption", evidence: evidence("settlement") },
    legs: [
      {
        legId: "spot",
        venue: "alpha",
        instrumentId: "alpha:spot:BTCUSDT",
        marketType: "spot",
        side: "buy",
        liquidity: "taker",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        baseQuantity: 1,
        price: 100_000,
        feeTier: { venue: "alpha", accountScope: "account-a", tier: "vip-1", makerBps: 1, takerBps: 5, feeAsset: "USDT", rebateCreditVerified: true, evidence: evidence("fee-alpha") }
      },
      {
        legId: "perp",
        venue: "beta",
        instrumentId: "beta:perpetual:BTCUSDT",
        marketType: "perpetual",
        side: "sell",
        liquidity: "taker",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        baseQuantity: 1,
        price: 101_000,
        feeTier: { venue: "beta", accountScope: "account-b", tier: "base", makerBps: 2, takerBps: 6, feeAsset: "USDT", rebateCreditVerified: true, evidence: evidence("fee-beta") }
      }
    ],
    fxRates: [],
    margin: [{ venue: "beta", instrumentId: "beta:perpetual:BTCUSDT", collateralAsset: "USDT", notionalQuote: 101_000, initialMarginBps: 1_000, maintenanceMarginBps: 500, safetyBufferBps: 500, evidence: evidence("margin") }],
    capital: [
      { venue: "alpha", asset: "USDT", available: 120_000, reserved: 0, haircutBps: 0, evidence: evidence("capital-alpha") },
      { venue: "beta", asset: "USDT", available: 20_000, reserved: 0, haircutBps: 0, evidence: evidence("capital-beta") }
    ]
  };
}

describe("route economics", () => {
  it("prices exact fee tiers and verifies capital per venue/asset", () => {
    const result = evaluateRouteEconomics(request());
    expect(result).toMatchObject({ eligible: true, outcomeClass: "projected", modelVersion: "route-economics-v1" });
    expect(result.costs.feesConservative).toBeCloseTo(110.6);
    expect(result.requiredCapital).toEqual([
      { venue: "alpha", asset: "USDT", required: 100_050, available: 120_000, shortfall: 0 },
      { venue: "beta", asset: "USDT", required: 15_210.6, available: 20_000, shortfall: 0 }
    ]);
    expect(result.riskFlags).toContain("independent-venue-leg-risk");
  });

  it("never credits unverified future funding in the conservative result", () => {
    const input = request();
    input.funding = [{ instrumentId: input.legs[1]!.instrumentId, position: "short", notionalQuote: 100_000, settlementAt: NOW + 30 * 60_000, rateBps: 10, kind: "venue-estimate", evidence: evidence("funding") }];
    const result = evaluateRouteEconomics(input);
    expect(result.costs.fundingProjected).toBe(100);
    expect(result.costs.fundingConservative).toBe(0);
    expect(result.costs.totalConservative).toBeGreaterThan(result.costs.totalProjected);
  });

  it("retains an adverse future funding debit", () => {
    const input = request();
    input.funding = [{ instrumentId: input.legs[1]!.instrumentId, position: "short", notionalQuote: 100_000, settlementAt: NOW + 30 * 60_000, rateBps: -10, kind: "venue-estimate", evidence: evidence("funding") }];
    const result = evaluateRouteEconomics(input);
    expect(result.costs.fundingProjected).toBe(-100);
    expect(result.costs.fundingConservative).toBe(-100);
  });

  it("fails closed on insufficient or recallable borrow when required", () => {
    const input = request();
    input.requireNonRecallableBorrow = true;
    input.borrow = [{ venue: "alpha", asset: "BTC", requestedQuantity: 1, availableQuantity: 0.5, annualRateBps: 1_000, recallable: true, evidence: evidence("borrow") }];
    const result = evaluateRouteEconomics(input);
    expect(result.eligible).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining(["borrow-unavailable", "borrow-recall-risk"]));
  });

  it("binds transfer health and fees to an exact asset network", () => {
    const input = request();
    input.transfers = [{ fromVenue: "alpha", toVenue: "beta", asset: "USDT", network: "TRX", quantity: 1_000, withdrawEnabled: false, depositEnabled: true, feeAsset: "USDT", feeQuantity: 1, estimatedArrivalMs: 60 * 60_000, evidence: evidence("network") }];
    const result = evaluateRouteEconomics(input);
    expect(result.eligible).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining(["transfer-unavailable", "transfer-too-slow"]));
  });

  it("rejects a stable-asset deviation beyond policy", () => {
    const input = request();
    input.fxRates = [{ baseAsset: "USDT", quoteAsset: "USD", bid: 0.97, ask: 0.971, evidence: evidence("fx") }];
    input.stableAssets = [{ asset: "USDT", referenceAsset: "USD", maximumDeviationBps: 100 }];
    const result = evaluateRouteEconomics(input);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "stable-asset-depeg", subject: "USDT" }));
  });

  it("requires explicit quantity and FX for a non-quote fee asset", () => {
    const input = request();
    input.legs[0]!.feeTier.feeAsset = "BNB";
    let result = evaluateRouteEconomics(input);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "fee-quantity-missing" }));
    input.legs[0]!.feeAssetQuantity = 0.1;
    result = evaluateRouteEconomics(input);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "missing-fx", subject: "BNB" }));
  });

  it("excludes a conditional maker rebate from conservative fees", () => {
    const input = request();
    input.legs[0]!.liquidity = "maker";
    input.legs[0]!.feeTier.makerBps = -2;
    input.legs[0]!.feeTier.rebateCreditVerified = false;
    const result = evaluateRouteEconomics(input);
    expect(result.costs.feesProjected).toBeCloseTo(40.6);
    expect(result.costs.feesConservative).toBeCloseTo(60.6);
    expect(result.riskFlags).toContain("conditional-maker-rebate");
  });

  it("rejects stale evidence, quantity residual and legging skew", () => {
    const input = request();
    input.legs[0]!.feeTier.evidence = { ...evidence("stale"), asOf: NOW - 120_000 };
    input.execution.residualBaseQuantity = 0.1;
    input.execution.observedLegSkewMs = 1_000;
    const result = evaluateRouteEconomics(input);
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining(["stale-evidence", "quantity-mismatch", "legging-window-exceeded"]));
  });

  it("uses locked only for fixed, venue-atomic and operationally closed evidence", () => {
    const input = request();
    input.execution.atomicity = "venue-atomic";
    input.settlement.kind = "fixed";
    expect(evaluateRouteEconomics(input).outcomeClass).toBe("locked");
    input.settlement.kind = "statistical-model";
    expect(evaluateRouteEconomics(input).outcomeClass).toBe("statistical");
  });
});
