import { describe, expect, it } from "vitest";
import { ArbitrageRouteDependencyIndex } from "../src/arbitrage/routeDependencyIndex.js";
import { ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES, capArbitrageStreamSnapshot, shouldDisconnectSlowArbitrageClient } from "../src/arbitrage/stream.js";
import type { ArbitrageOpportunity, ArbitrageScanResponse } from "../src/arbitrage/types.js";

describe("10,000-route scanner scale boundaries", () => {
  it("recomputes only routes dependent on one ticker update", () => {
    const routes = Array.from({ length: 10_000 }, (_, index) => opportunity(index));
    const index = new ArbitrageRouteDependencyIndex();
    index.replace(routes);

    expect(index.stats()).toEqual({ routes: 10_000, keys: 20_000, references: 20_000 });
    expect(index.idsFor({ exchange: "binance", market: "spot", symbol: "ASSET04200USDT" })).toEqual(["route-4200"]);
    expect(index.idsFor({ exchange: "bybit", market: "perpetual", symbol: "ASSET04200USDT" })).toEqual(["route-4200"]);
    expect(index.idsFor({ exchange: "binance", market: "spot", symbol: "UNKNOWNUSDT" })).toEqual([]);
  });

  it("bounds browser broadcasts while preserving full totals for server consumers", () => {
    const scan: ArbitrageScanResponse = {
      updatedAt: 1,
      stale: false,
      scannedSymbols: 10_000,
      totalOpportunities: 10_000,
      truncated: false,
      estimatedTotalCostBps: 0,
      opportunities: Array.from({ length: 10_000 }, (_, index) => opportunity(index)),
      sources: []
    };
    const publicScan = capArbitrageStreamSnapshot(scan);

    expect(publicScan.opportunities).toHaveLength(250);
    expect(publicScan.totalOpportunities).toBe(10_000);
    expect(publicScan.truncated).toBe(true);
    expect(scan.opportunities).toHaveLength(10_000);
    expect(Buffer.byteLength(JSON.stringify(publicScan), "utf8")).toBeLessThan(ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES);
  });

  it("disconnects slow or invalid clients at the explicit backpressure boundary", () => {
    expect(shouldDisconnectSlowArbitrageClient(ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES)).toBe(false);
    expect(shouldDisconnectSlowArbitrageClient(ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES + 1)).toBe(true);
    expect(shouldDisconnectSlowArbitrageClient(Number.NaN)).toBe(true);
  });
});

function opportunity(index: number): ArbitrageOpportunity {
  const serial = String(index).padStart(5, "0");
  const symbol = `ASSET${serial}USDT`;
  return {
    id: `route-${index}`,
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: "cross-venue-reviewed",
    symbol,
    assetId: `ASSET${serial}`,
    spotInstrumentId: `binance:spot:${symbol}`,
    futuresInstrumentId: `bybit:perpetual:${symbol}`,
    spotExchange: "binance",
    futuresExchange: "bybit",
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 10,
    futuresBid: 101,
    futuresAsk: 102,
    futuresBidSize: 10,
    grossSpreadBps: 100,
    estimatedTotalCostBps: 10,
    netEdgeBps: 90,
    topBookCapacityUsd: 1_000,
    topBookMatchedQuantity: 10,
    expectedNetProfitUsd: 9,
    fundingRate: 0,
    fundingScheduleVerified: false,
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
}
