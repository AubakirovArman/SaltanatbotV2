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
  fundingIntervalMinutes?: number;
  /** Venue-provided timestamp. Omitted when the stream event has none. */
  exchangeTs?: number;
  /** False when the venue did not provide exchangeTs. */
  exchangeTimestampVerified: boolean;
  receivedAt: number;
  /** @deprecated local capture time; use exchangeTs for venue time and receivedAt for local time. */
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
