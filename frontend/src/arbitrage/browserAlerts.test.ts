import { describe, expect, it } from "vitest";
import { evaluateBrowserAlertSnapshot, type BrowserAlertState } from "./browserAlerts";
import type { ArbitrageOpportunity, ArbitrageScanResponse } from "./client";

describe("browser arbitrage alert quality gate", () => {
  it("alerts an independent fresh route while a failed source blocks only its dependent route", () => {
    const independent = quote("route-a", "fresh", "binance", "bybit");
    const dependent = quote("route-b", "fresh", "bybit", "binance");
    const result = evaluateBrowserAlertSnapshot(scan(true, [independent, dependent], [source("binance", "spot", true), source("binance", "perpetual", true), source("bybit", "spot", false), source("bybit", "perpetual", true)]), state(true), () => true);

    expect(result.fired.map((row) => row.id)).toEqual(["route-a"]);
    expect([...result.state.eligibleRouteIds]).toEqual(["route-a"]);
  });

  it("preserves prior state across unverified rows and fires only on a fresh crossing", () => {
    const previous = state(true, ["route-a"]);
    const unverified = evaluateBrowserAlertSnapshot(scan(false, [quote("route-a", "unverified"), quote("route-b", "unverified")]), previous, () => true);
    const recovered = evaluateBrowserAlertSnapshot(scan(false, [quote("route-a", "fresh"), quote("route-b", "fresh")]), unverified.state, () => true);

    expect(unverified.fired).toEqual([]);
    expect([...unverified.state.eligibleRouteIds]).toEqual(["route-a"]);
    expect(recovered.fired.map((row) => row.id)).toEqual(["route-b"]);
  });

  it("uses the first trustworthy snapshot only as a baseline", () => {
    const result = evaluateBrowserAlertSnapshot(scan(false, [quote("route-a", "fresh")]), state(false), () => true);
    expect(result.fired).toEqual([]);
    expect([...result.state.eligibleRouteIds]).toEqual(["route-a"]);
  });

  it("does not let an incomplete envelope prove an absent-route down-crossing", () => {
    const previous = state(true, ["route-a"]);
    const incomplete = evaluateBrowserAlertSnapshot(scan(true, [], [source("binance", "spot", false)]), previous, () => true);

    expect(incomplete.fired).toEqual([]);
    expect(incomplete.state).toBe(previous);
  });
});

function state(initialized: boolean, ids: string[] = []): BrowserAlertState {
  return { initialized, eligibleRouteIds: new Set(ids) };
}

function scan(stale: boolean, opportunities: ArbitrageOpportunity[], sources: ArbitrageScanResponse["sources"] = healthySources()): ArbitrageScanResponse {
  return {
    updatedAt: 1,
    stale,
    scannedSymbols: opportunities.length,
    totalOpportunities: opportunities.length,
    truncated: false,
    estimatedTotalCostBps: 0,
    opportunities,
    sources
  };
}

function quote(id: string, dataQuality: ArbitrageOpportunity["dataQuality"], spotExchange: ArbitrageOpportunity["spotExchange"] = "binance", futuresExchange: ArbitrageOpportunity["futuresExchange"] = "bybit"): ArbitrageOpportunity {
  return {
    id,
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: spotExchange === futuresExchange ? "venue-native" : "cross-venue-reviewed",
    symbol: "BTCUSDT",
    assetId: "crypto:bitcoin",
    spotInstrumentId: `${spotExchange}:spot:BTCUSDT`,
    futuresInstrumentId: `${futuresExchange}:perpetual:BTCUSDT`,
    spotExchange,
    futuresExchange,
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 1,
    futuresBid: 101,
    futuresAsk: 102,
    futuresBidSize: 1,
    grossSpreadBps: 100,
    estimatedTotalCostBps: 0,
    netEdgeBps: 100,
    topBookCapacityUsd: 100,
    topBookMatchedQuantity: 1,
    expectedNetProfitUsd: 1,
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
    dataQuality,
    capturedAt: 1
  };
}

function healthySources(): ArbitrageScanResponse["sources"] {
  return [source("binance", "spot", true), source("binance", "perpetual", true), source("bybit", "spot", true), source("bybit", "perpetual", true)];
}

function source(exchange: ArbitrageOpportunity["spotExchange"], market: "spot" | "perpetual", ok: boolean): ArbitrageScanResponse["sources"][number] {
  return { exchange, market, ok };
}
