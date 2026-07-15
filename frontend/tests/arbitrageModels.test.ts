import { describe, expect, it, vi } from "vitest";
import { parseArbitrageDepth, parseArbitrageScan, parseArbitrageStreamMessage, type ArbitrageDepthResponse, type ArbitrageOpportunity } from "../src/arbitrage/client";
import { capitalEstimate, convergenceScenarios, DEFAULT_FEE_PROFILE, netEdgeBps, projectedFundingSettlements, projectedNetProfitUsd, projectedRoiPct, routeCostBps, routeCostBreakdown } from "../src/arbitrage/fees";
import { closePaperPosition, openPaperPosition, paperAnalytics, paperPnl } from "../src/arbitrage/paper";
import { chartPath } from "../src/arbitrage/ArbitrageHistoryChart";

const row: ArbitrageOpportunity = {
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
  futuresBid: 103,
  futuresAsk: 104,
  futuresBidSize: 10,
  grossSpreadBps: 300,
  estimatedTotalCostBps: 0,
  netEdgeBps: 300,
  topBookCapacityUsd: 1_000,
  topBookMatchedQuantity: 10,
  expectedNetProfitUsd: 30,
  fundingRate: 0,
  fundingIntervalMinutes: 480,
  fundingScheduleVerified: true,
  nextFundingTime: 3_600_000,
  spotExchangeTs: 1,
  spotExchangeTimestampVerified: true,
  spotReceivedAt: 1,
  futuresExchangeTs: 1,
  futuresExchangeTimestampVerified: true,
  futuresReceivedAt: 1,
  quoteAgeMs: 0,
  legSkewMs: 0,
  dataQuality: "fresh",
  capturedAt: 1
};

const freshTiming = {
  spot: { exchangeTs: 1, receivedAt: 1, ageMs: 0 },
  perpetual: { exchangeTs: 1, receivedAt: 1, ageMs: 0 },
  ageMs: 0,
  receiveSkewMs: 0,
  exchangeSkewMs: 0,
  legSkewMs: 0,
  exchangeTimestampsVerified: true,
  quality: "fresh" as const
};
const verifiedConstraints = { metadataVerified: true, minimumsSatisfied: true, verified: true, failures: [] } as const;
const depthIdentity = {
  identityScope: "cross-venue-reviewed" as const,
  assetId: "crypto:bitcoin",
  economicAssetId: "crypto:bitcoin",
  spotInstrumentId: "binance:spot:BTCUSDT",
  futuresInstrumentId: "bybit:perpetual:BTCUSDT"
};

describe("arbitrage browser models", () => {
  it("parses bounded REST and stream contracts", () => {
    const scan = {
      updatedAt: 1,
      stale: false,
      scannedSymbols: 1,
      estimatedTotalCostBps: 0,
      sources: [
        { exchange: "binance" as const, market: "spot" as const, ok: true },
        { exchange: "bybit" as const, market: "perpetual" as const, ok: true }
      ],
      opportunities: [row]
    };
    expect(parseArbitrageScan(scan).opportunities[0].spotBid).toBe(99);
    expect(parseArbitrageStreamMessage({ type: "arbitrage_snapshot", data: scan }).type).toBe("snapshot");
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 };
    const parsedDepth = parseArbitrageDepth({ ...depthIdentity, symbol: "BTCUSDT", requestedNotionalUsd: 100, spot: leg, perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell" }, timing: freshTiming, constraints: verifiedConstraints, grossSpreadBps: 10, complete: true, capturedAt: 1 });
    expect(parsedDepth.complete).toBe(true);
    expect(parsedDepth.matchedQuantity).toBe(1);
    expect(parsedDepth.quantityStepSource).toBe("fallback");
    expect(parsedDepth.precisionVerified).toBe(false);
    expect(parseArbitrageDepth(parsedDepth, row, "entry")).toEqual(parsedDepth);
    expect(() => parseArbitrageDepth(parsedDepth, { ...row, assetId: "crypto:ethereum" }, "entry")).toThrow(/selected route/);
    expect(() => parseArbitrageDepth({ ...parsedDepth, perpetual: { ...parsedDepth.perpetual, side: "buy" } }, row, "entry")).toThrow(/requested direction/);
  });

  it("uses route-specific round-trip fees", () => {
    expect(routeCostBps(row, DEFAULT_FEE_PROFILE)).toBe(40);
    expect(netEdgeBps(row, DEFAULT_FEE_PROFILE)).toBe(260);
  });

  it("models funding, financing and fixed transfer costs for the selected notional", () => {
    const profile = { ...DEFAULT_FEE_PROFILE, expectedHoldingHours: 8, annualBorrowRatePct: 10, transferCostUsd: 5 };
    const cost = routeCostBreakdown({ ...row, fundingRate: 0.0001 }, profile, 1_000, 0);
    expect(cost.transferCostBps).toBe(50);
    expect(cost.fundingCostBps).toBe(-1);
    expect(cost.borrowCostBps).toBeCloseTo(0.9132, 3);
    expect(cost.totalBps).toBeCloseTo(89.9132, 3);
    expect(cost.fundingSettlementCount).toBe(1);
    expect(projectedFundingSettlements({ ...row, fundingIntervalMinutes: 60, nextFundingTime: 60 * 60_000 }, 3, 0)).toBe(3);
    expect(projectedFundingSettlements({ ...row, fundingScheduleVerified: false }, 24, 0)).toBe(0);
    const adverseUnknown = { ...row, fundingRate: -0.001, fundingScheduleVerified: false, fundingIntervalMinutes: undefined, nextFundingTime: 60 * 60_000 };
    expect(projectedFundingSettlements(adverseUnknown, 8, 0)).toBe(1);
    expect(projectedFundingSettlements({ ...adverseUnknown, nextFundingTime: undefined }, 8, 0)).toBe(1);
    expect(routeCostBreakdown(adverseUnknown, { ...DEFAULT_FEE_PROFILE, expectedHoldingHours: 8 }, 1_000, 0).fundingCostBps).toBe(10);
    expect(projectedFundingSettlements({ ...adverseUnknown, fundingRate: 0.001 }, 8, 0)).toBe(0);
  });

  it("ranks projected executable dollars using the selected notional and capacity", () => {
    expect(projectedNetProfitUsd({ ...row, topBookCapacityUsd: 100 }, DEFAULT_FEE_PROFILE, 10_000)).toBeCloseTo(2.6, 6);
  });

  it("uses an explicit capital denominator and monotonic convergence scenarios", () => {
    const capital = capitalEstimate(row, DEFAULT_FEE_PROFILE, 1_000);
    expect(capital).toMatchObject({ spotCapitalUsd: 1_000, derivativeInitialMarginUsd: 200, derivativeSafetyBufferUsd: 100, requiredCapitalUsd: 1_300 });
    expect(projectedRoiPct(row, DEFAULT_FEE_PROFILE, 1_000)).toBeCloseTo((26 / 1_300) * 100, 8);
    const scenarios = convergenceScenarios(row, DEFAULT_FEE_PROFILE, 1_000, 0);
    expect(scenarios.map((scenario) => scenario.convergencePct)).toEqual([100, 75, 50, 25, 0]);
    expect(scenarios.map((scenario) => scenario.netPnlUsd)).toEqual([...scenarios.map((scenario) => scenario.netPnlUsd)].sort((left, right) => right - left));
    expect(scenarios.at(-1)?.netPnlUsd).toBeLessThan(0);
    const expensive = { ...DEFAULT_FEE_PROFILE, binanceSpotTakerBps: DEFAULT_FEE_PROFILE.binanceSpotTakerBps + 1 };
    expect(projectedNetProfitUsd(row, expensive, 1_000)).toBeLessThan(projectedNetProfitUsd(row, DEFAULT_FEE_PROFILE, 1_000));
  });

  it("opens from depth VWAP and marks both paper legs to executable close quotes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 } as const;
    const depth: ArbitrageDepthResponse = {
      ...depthIdentity,
      symbol: "BTCUSDT",
      direction: "entry",
      requestedNotionalUsd: 100,
      targetQuantity: 1,
      matchedQuantity: 1,
      quantityStep: 0.001,
      quantityStepSource: "instrument",
      precisionVerified: true,
      roundingDustQuantity: 0,
      liquidityShortfallQuantity: 0,
      residualDeltaQuantity: 0,
      spot: leg,
      perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell", filledNotionalUsd: 103, averagePrice: 103, topPrice: 103, worstPrice: 103 },
      timing: freshTiming,
      constraints: { ...verifiedConstraints, failures: [] },
      grossSpreadBps: 300,
      complete: true,
      capturedAt: 1
    };
    const position = openPaperPosition(row, depth, DEFAULT_FEE_PROFILE, 10);
    expect(() => openPaperPosition({ ...row, assetId: "crypto:ethereum" }, depth, DEFAULT_FEE_PROFILE, 10)).toThrow(/selected route/);
    expect(position.estimatedRoundTripCostUsd).toBe(0.4);
    expect(openPaperPosition({ ...row, fundingRate: 0.01, fundingIntervalMinutes: 60, nextFundingTime: 11 }, depth, DEFAULT_FEE_PROFILE, 10).estimatedRoundTripCostUsd).toBe(0.4);
    expect(position.spotQuantity).toBe(position.futuresQuantity);
    expect(position.matchedQuantity).toBe(1);
    expect(position.residualDeltaQuantity).toBe(0);
    expect(paperPnl(position, { ...row, spotBid: 101, futuresAsk: 102 })).toBeCloseTo(1.6, 10);
    expect(closePaperPosition(position, { ...row, spotBid: 101, futuresAsk: 102 }, 20).realizedPnlUsd).toBeCloseTo(1.6, 10);
    expect(() => closePaperPosition(position, { ...row, futuresInstrumentId: "bybit:perpetual:ETHUSDT" }, 20)).toThrow(/open paper position/);
    const closed = closePaperPosition(position, { ...row, spotBid: 101, futuresAsk: 102 }, 20);
    expect(paperAnalytics([closed], [row])).toMatchObject({ total: 1, open: 0, closed: 1, winRatePct: 100 });

    const missingQuote = paperAnalytics([position], []);
    expect(missingQuote).toMatchObject({ open: 1, pricedOpenPositions: 0, knownUnrealizedPnlUsd: 0 });
    expect(missingQuote.unrealizedPnlUsd).toBeUndefined();

    const mismatchedQuote = paperAnalytics([position], [{ ...row, assetId: "crypto:ethereum" }]);
    expect(mismatchedQuote).toMatchObject({ open: 1, pricedOpenPositions: 0, knownUnrealizedPnlUsd: 0 });
    expect(mismatchedQuote.unrealizedPnlUsd).toBeUndefined();

    const otherPosition = {
      ...position,
      id: "paper-eth",
      routeId: "ETHUSDT:binance:bybit",
      assetId: "crypto:ethereum",
      symbol: "ETHUSDT",
      spotInstrumentId: "binance:spot:ETHUSDT",
      futuresInstrumentId: "bybit:perpetual:ETHUSDT"
    };
    const partial = paperAnalytics([position, otherPosition], [{ ...row, spotBid: 101, futuresAsk: 102 }]);
    expect(partial).toMatchObject({ open: 2, pricedOpenPositions: 1, knownUnrealizedPnlUsd: 1.6 });
    expect(partial.unrealizedPnlUsd).toBeUndefined();

    const complete = paperAnalytics([position], [{ ...row, spotBid: 101, futuresAsk: 102 }]);
    expect(complete).toMatchObject({ open: 1, pricedOpenPositions: 1, knownUnrealizedPnlUsd: 1.6, unrealizedPnlUsd: 1.6 });
  });

  it("fails closed when a depth payload would leave directional paper exposure", () => {
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 } as const;
    const depth: ArbitrageDepthResponse = {
      ...depthIdentity,
      symbol: "BTCUSDT",
      direction: "entry",
      requestedNotionalUsd: 100,
      targetQuantity: 1,
      matchedQuantity: 0.99,
      quantityStep: 0.01,
      quantityStepSource: "instrument",
      precisionVerified: true,
      roundingDustQuantity: 0,
      liquidityShortfallQuantity: 0,
      residualDeltaQuantity: 0.01,
      spot: leg,
      perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell", quantity: 0.99, filledNotionalUsd: 101.97, averagePrice: 103, topPrice: 103, worstPrice: 103 },
      timing: freshTiming,
      constraints: { ...verifiedConstraints, failures: [] },
      grossSpreadBps: 300,
      complete: true,
      capturedAt: 1
    };
    expect(() => openPaperPosition(row, depth, DEFAULT_FEE_PROFILE, 10)).toThrow(/delta-neutral/);
  });

  it("blocks paper entry on stale books or fallback quantity precision", () => {
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 20_001 } as const;
    const depth: ArbitrageDepthResponse = {
      ...depthIdentity,
      symbol: "BTCUSDT",
      direction: "entry",
      requestedNotionalUsd: 100,
      targetQuantity: 1,
      matchedQuantity: 1,
      quantityStep: 0.001,
      quantityStepSource: "instrument",
      precisionVerified: true,
      roundingDustQuantity: 0,
      liquidityShortfallQuantity: 0,
      residualDeltaQuantity: 0,
      spot: leg,
      perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell", averagePrice: 103, topPrice: 103, worstPrice: 103 },
      timing: {
        spot: { exchangeTs: 1, receivedAt: 1, ageMs: 20_000 },
        perpetual: { exchangeTs: 1, receivedAt: 1, ageMs: 20_000 },
        ageMs: 20_000,
        receiveSkewMs: 0,
        exchangeSkewMs: 0,
        legSkewMs: 0,
        exchangeTimestampsVerified: true,
        quality: "stale"
      },
      constraints: { ...verifiedConstraints, failures: [] },
      grossSpreadBps: 300,
      complete: true,
      capturedAt: 20_001
    };
    expect(() => openPaperPosition(row, depth, DEFAULT_FEE_PROFILE, 20_001)).toThrow(/fresh, synchronized/);
    expect(() =>
      openPaperPosition(
        row,
        {
          ...depth,
          timing: {
            spot: { receivedAt: 1, ageMs: 0 },
            perpetual: { exchangeTs: 1, receivedAt: 1, ageMs: 0 },
            ageMs: 0,
            receiveSkewMs: 0,
            legSkewMs: 0,
            exchangeTimestampsVerified: false,
            quality: "unverified"
          },
          capturedAt: 1,
          complete: false
        },
        DEFAULT_FEE_PROFILE,
        1
      )
    ).toThrow(/venue-verified timestamps/);
    expect(() => openPaperPosition(row, { ...depth, timing: freshTiming, capturedAt: 1, precisionVerified: false, quantityStepSource: "fallback" }, DEFAULT_FEE_PROFILE, 20_001)).toThrow(/verified instrument/);
  });

  it("builds a bounded SVG history path", () => {
    expect(chartPath([{ grossSpreadBps: 10 }, { grossSpreadBps: 20 }, { grossSpreadBps: 15 }])).toBe("M0.00,66.00 L160.00,6.00 L320.00,36.00");
  });
});
