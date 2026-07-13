import { describe, expect, it, vi } from "vitest";
import { parseArbitrageDepth, parseArbitrageScan, parseArbitrageStreamMessage, type ArbitrageDepthResponse, type ArbitrageOpportunity } from "../src/arbitrage/client";
import { DEFAULT_FEE_PROFILE, netEdgeBps, routeCostBps, routeCostBreakdown } from "../src/arbitrage/fees";
import { closePaperPosition, openPaperPosition, paperAnalytics, paperPnl } from "../src/arbitrage/paper";
import { chartPath } from "../src/arbitrage/ArbitrageHistoryChart";

const row: ArbitrageOpportunity = {
  id: "BTCUSDT:binance:bybit",
  symbol: "BTCUSDT",
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
  fundingRate: 0,
  capturedAt: 1
};

describe("arbitrage browser models", () => {
  it("parses bounded REST and stream contracts", () => {
    const scan = { updatedAt: 1, stale: false, scannedSymbols: 1, estimatedTotalCostBps: 0, sources: [], opportunities: [row] };
    expect(parseArbitrageScan(scan).opportunities[0].spotBid).toBe(99);
    expect(parseArbitrageStreamMessage({ type: "arbitrage_snapshot", data: scan }).type).toBe("snapshot");
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 };
    expect(parseArbitrageDepth({ symbol: "BTCUSDT", requestedNotionalUsd: 100, spot: leg, perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell" }, grossSpreadBps: 10, complete: true, capturedAt: 1 }).complete).toBe(true);
  });

  it("uses route-specific round-trip fees", () => {
    expect(routeCostBps(row, DEFAULT_FEE_PROFILE)).toBe(40);
    expect(netEdgeBps(row, DEFAULT_FEE_PROFILE)).toBe(260);
  });

  it("models funding, financing and fixed transfer costs for the selected notional", () => {
    const profile = { ...DEFAULT_FEE_PROFILE, expectedHoldingHours: 8, annualBorrowRatePct: 10, transferCostUsd: 5 };
    const cost = routeCostBreakdown({ ...row, fundingRate: 0.0001 }, profile, 1_000);
    expect(cost.transferCostBps).toBe(50);
    expect(cost.fundingCostBps).toBe(-1);
    expect(cost.borrowCostBps).toBeCloseTo(0.9132, 3);
    expect(cost.totalBps).toBeCloseTo(89.9132, 3);
  });

  it("opens from depth VWAP and marks both paper legs to executable close quotes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 } as const;
    const depth: ArbitrageDepthResponse = { symbol: "BTCUSDT", requestedNotionalUsd: 100, spot: leg, perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell", quantity: 100 / 103, averagePrice: 103, topPrice: 103, worstPrice: 103 }, grossSpreadBps: 300, complete: true, capturedAt: 1 };
    const position = openPaperPosition(row, depth, DEFAULT_FEE_PROFILE, 10);
    expect(position.estimatedRoundTripCostUsd).toBe(0.4);
    expect(paperPnl(position, { ...row, spotBid: 101, futuresAsk: 102 })).toBeCloseTo(1.57087, 4);
    expect(closePaperPosition(position, { ...row, spotBid: 101, futuresAsk: 102 }, 20).realizedPnlUsd).toBeCloseTo(1.57087, 4);
    const closed = closePaperPosition(position, { ...row, spotBid: 101, futuresAsk: 102 }, 20);
    expect(paperAnalytics([closed], [row])).toMatchObject({ total: 1, open: 0, closed: 1, winRatePct: 100 });
  });

  it("builds a bounded SVG history path", () => {
    expect(chartPath([{ grossSpreadBps: 10 }, { grossSpreadBps: 20 }, { grossSpreadBps: 15 }])).toBe("M0.00,66.00 L160.00,6.00 L320.00,36.00");
  });
});
