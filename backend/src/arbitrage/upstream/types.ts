import type { ArbitrageExchange, ArbitrageMarket } from "../types.js";

export interface ArbitrageTickerUpdate {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  symbol: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  fundingRate?: number;
  nextFundingTime?: number;
  capturedAt: number;
}

export interface ArbitrageUpstreamStatus {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  ok: boolean;
  message?: string;
}

export type TickerListener = (update: ArbitrageTickerUpdate) => void;
export type StatusListener = (status: ArbitrageUpstreamStatus) => void;
