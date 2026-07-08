import type { Candle, Instrument, Timeframe } from "../types.js";
import { BinanceProvider } from "./binance.js";
import { BybitProvider } from "./bybit.js";
import { CandleCache } from "./cache.js";
import type { CandleRange, MarketProvider, MarketSubscription } from "./provider.js";
import { SyntheticProvider } from "./synthetic.js";

export type DataExchange = "binance" | "bybit";

export class ProviderRouter implements MarketProvider {
  readonly name = "Provider router";

  private binance = new BinanceProvider();

  private bybit = new BybitProvider();

  private synthetic = new SyntheticProvider();

  private cache = new CandleCache();

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, exchange?: DataExchange) {
    const now = Date.now();
    const isHistory = range.endTime !== undefined && range.endTime < now - 60_000;
    const source = this.sourceKey(instrument, exchange);
    const cacheKey = `${source}:${instrument.symbol}:${timeframe}:${range.limit}:${range.endTime ?? "live"}:${range.startTime ?? ""}`;
    const cached = this.cache.get(cacheKey, now);
    if (cached) return cached;

    const provider = this.primary(instrument, exchange);
    let candles: Candle[];
    try {
      candles = await provider.getCandles(instrument, timeframe, range);
    } catch (error) {
      const fallback = await this.synthetic.getCandles(instrument, timeframe, range);
      candles = fallback.map((candle) => ({
        ...candle,
        source: `Fallback after ${this.message(error)}`
      }));
    }
    this.cache.set(cacheKey, candles, now, isHistory);
    return candles;
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    exchange?: DataExchange
  ): Promise<MarketSubscription> {
    const provider = this.primary(instrument, exchange);
    if (provider === this.synthetic) {
      return this.synthetic.subscribe(instrument, timeframe, onCandle, onStatus);
    }

    try {
      return await provider.subscribe(instrument, timeframe, onCandle, onStatus);
    } catch (error) {
      onStatus?.(`Fallback stream: ${this.message(error)}`);
      return this.synthetic.subscribe(instrument, timeframe, onCandle, onStatus);
    }
  }

  private primary(instrument: Instrument, exchange?: DataExchange) {
    if (instrument.provider !== "binance") return this.synthetic;
    return exchange === "bybit" ? this.bybit : this.binance;
  }

  private sourceKey(instrument: Instrument, exchange?: DataExchange) {
    if (instrument.provider !== "binance") return "synthetic";
    return exchange === "bybit" ? "bybit" : "binance";
  }

  private message(error: unknown) {
    return error instanceof Error ? error.message : "unknown provider error";
  }
}
