export type ArbitrageExchange = "binance" | "bybit";
export type ArbitrageMarket = "spot" | "perpetual";

export interface ArbitrageVenueQuote {
  symbol: string;
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  fundingRate?: number;
  nextFundingTime?: number;
}

export interface ArbitrageOpportunity {
  id: string;
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  spotAsk: number;
  spotAskSize: number;
  futuresBid: number;
  futuresBidSize: number;
  grossSpreadBps: number;
  estimatedTotalCostBps: number;
  netEdgeBps: number;
  topBookCapacityUsd: number;
  fundingRate: number;
  nextFundingTime?: number;
  capturedAt: number;
}

export interface ArbitrageSourceStatus {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  ok: boolean;
  message?: string;
}

export interface ArbitrageScanResponse {
  updatedAt: number;
  stale: boolean;
  scannedSymbols: number;
  estimatedTotalCostBps: number;
  opportunities: ArbitrageOpportunity[];
  sources: ArbitrageSourceStatus[];
}
