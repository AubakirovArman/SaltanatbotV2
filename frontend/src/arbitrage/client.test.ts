import { describe, expect, it } from "vitest";
import { parseArbitrageScan } from "./client";

describe("arbitrage transport contract", () => {
  it("accepts a bounded typed snapshot", () => {
    expect(parseArbitrageScan({
      updatedAt: 1, stale: false, scannedSymbols: 1, estimatedTotalCostBps: 30,
      sources: [{ exchange: "binance", market: "spot", ok: true }],
      opportunities: [{
        id: "BTCUSDT:binance:bybit", symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit",
        spotAsk: 100, spotAskSize: 2, futuresBid: 101, futuresBidSize: 2, grossSpreadBps: 100,
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
});
