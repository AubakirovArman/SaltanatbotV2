import { describe, expect, it } from "vitest";
import { parseArbitrageDepth, parseArbitrageScan, parseArbitrageStreamMessage } from "./client";

describe("arbitrage transport contract", () => {
  it("accepts a bounded typed snapshot", () => {
    expect(parseArbitrageScan({
      updatedAt: 1, stale: false, scannedSymbols: 1, estimatedTotalCostBps: 30,
      sources: [{ exchange: "binance", market: "spot", ok: true }],
      opportunities: [{
        id: "BTCUSDT:binance:bybit", symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit",
        spotBid: 99, spotAsk: 100, spotAskSize: 2, futuresBid: 101, futuresAsk: 102, futuresBidSize: 2, grossSpreadBps: 100,
        estimatedTotalCostBps: 30, netEdgeBps: 70, topBookCapacityUsd: 200, fundingRate: 0.0001,
        nextFundingTime: 2, capturedAt: 1
      }]
    }).opportunities[0].netEdgeBps).toBe(70);
  });

  it("rejects malformed venue data and unbounded result sets", () => {
    const base = { updatedAt: 1, stale: false, scannedSymbols: 0, estimatedTotalCostBps: 30, sources: [], opportunities: [] };
    expect(() => parseArbitrageScan({ ...base, sources: [{ exchange: "unknown", market: "spot", ok: true }] })).toThrow(/unsupported/);
    expect(() => parseArbitrageScan({ ...base, opportunities: Array.from({ length: 501 }, () => ({})) })).toThrow(/at most 500/);
  });

  it("parses stream snapshots and bounded depth results", () => {
    const scan = { updatedAt: 1, stale: false, scannedSymbols: 0, estimatedTotalCostBps: 0, sources: [], opportunities: [] };
    expect(parseArbitrageStreamMessage({ type: "arbitrage_snapshot", data: scan }).type).toBe("snapshot");
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 };
    const depth = parseArbitrageDepth({ symbol: "BTCUSDT", requestedNotionalUsd: 100, spot: leg, perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell" }, grossSpreadBps: 10, complete: true, capturedAt: 1 });
    expect(depth.perpetual.side).toBe("sell");
  });
});
