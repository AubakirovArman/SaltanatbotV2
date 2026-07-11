import type { Candle, Instrument, Timeframe } from "../types.js";

export type DataExchange = "binance" | "bybit";
export type DataMarketType = "spot" | "linear" | "inverse";
export type PriceType = "last" | "mark" | "index";

export interface MarketKey {
  venue: DataExchange;
  marketType: DataMarketType;
  symbol: string;
  timeframe: Timeframe;
  priceType: PriceType;
}

export interface MarketCandleEvent {
  marketKey: MarketKey;
  candle: Candle;
}

export interface MarketRouteOptions {
  marketType?: DataMarketType;
  priceType?: PriceType;
}

export interface MarketSubscription {
  close: () => void;
}

/**
 * Range/pagination options for a candle request.
 * - `limit`     — maximum number of bars to return.
 * - `endTime`   — return bars with open time <= endTime (paging into history).
 * - `startTime` — return bars with open time >= startTime.
 * When neither bound is set the provider returns the most recent `limit` bars.
 */
export interface CandleRange {
  limit: number;
  endTime?: number;
  startTime?: number;
}

export interface MarketProvider {
  readonly name: string;
  getCandles: (
    instrument: Instrument,
    timeframe: Timeframe,
    range: CandleRange,
    options?: MarketRouteOptions
  ) => Promise<Candle[]>;
  subscribe: (
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    options?: MarketRouteOptions
  ) => Promise<MarketSubscription>;
}
