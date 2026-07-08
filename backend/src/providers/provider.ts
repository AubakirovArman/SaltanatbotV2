import type { Candle, Instrument, Timeframe } from "../types.js";

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
    range: CandleRange
  ) => Promise<Candle[]>;
  subscribe: (
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void
  ) => Promise<MarketSubscription>;
}
