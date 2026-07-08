import type { Candle, Instrument, Timeframe } from "../types.js";
import { BinanceProvider } from "./binance.js";
import { BybitProvider } from "./bybit.js";
import { CandleCache } from "./cache.js";
import { readCandles, saveCandles, storedRange } from "./candleStore.js";
import type { CandleRange, MarketProvider, MarketSubscription } from "./provider.js";
import { SyntheticProvider } from "./synthetic.js";

export type DataExchange = "binance" | "bybit";

/** `strict` disables the synthetic fallback — live trading must never see fake data. */
export interface RouteOptions {
  exchange?: DataExchange;
  strict?: boolean;
}

export class ProviderRouter implements MarketProvider {
  readonly name = "Provider router";

  private binance = new BinanceProvider();

  private bybit = new BybitProvider();

  private synthetic = new SyntheticProvider();

  private cache = new CandleCache();

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, options?: DataExchange | RouteOptions) {
    const { exchange, strict } = normalizeOptions(options);
    const now = Date.now();
    const isHistory = range.endTime !== undefined && range.endTime < now - 60_000;
    const source = this.sourceKey(instrument, exchange);
    const cacheKey = `${source}:${instrument.symbol}:${timeframe}:${range.limit}:${range.endTime ?? "live"}:${range.startTime ?? ""}`;
    const cached = this.cache.get(cacheKey, now);
    if (cached) return cached;

    const provider = this.primary(instrument, exchange);
    const persistable = provider !== this.synthetic;

    // Deep-history fast path: a request paging into the past that the persistent
    // store can already satisfy in full is served from disk — instant, and
    // resilient if the exchange REST is throttled or down. Live/tip requests and
    // synthetic instruments always fall through to the provider below.
    if (isHistory && persistable) {
      const stored = this.fromStore(source, instrument, timeframe, range);
      if (stored) {
        this.cache.set(cacheKey, stored, now, isHistory);
        return stored;
      }
    }

    let candles: Candle[];
    try {
      candles = await provider.getCandles(instrument, timeframe, range);
      // Persist real exchange bars (fire-and-forget). Never persist synthetic or
      // fallback data — guard on the provider and on each candle's source.
      if (persistable) this.persist(source, instrument, timeframe, candles);
    } catch (error) {
      if (strict) throw error;
      const fallback = await this.synthetic.getCandles(instrument, timeframe, range);
      candles = fallback.map((candle) => ({
        ...candle,
        source: `Fallback after ${this.message(error)}`
      }));
    }
    this.cache.set(cacheKey, candles, now, isHistory);
    return candles;
  }

  /**
   * Return a full page of stored history for a past window, or undefined when
   * the store cannot fully satisfy it (so the caller hits REST instead). "Full"
   * means we either have `limit` bars at/below endTime, or the window already
   * reaches the oldest bar we hold (no older data exists to fetch). Any store
   * error degrades to undefined — the request simply falls through to REST.
   */
  private fromStore(source: string, instrument: Instrument, timeframe: Timeframe, range: CandleRange): Candle[] | undefined {
    try {
      const rows = readCandles(source, instrument.symbol, timeframe, {
        startTime: range.startTime,
        endTime: range.endTime,
        limit: range.limit
      });
      if (rows.length === 0) return undefined;
      if (rows.length >= range.limit) return rows;
      // Fewer than a full page: only trust it if we've reached the oldest stored
      // bar for this series (nothing older to page into) and no startTime floor
      // is cutting the window short.
      if (range.startTime !== undefined) return undefined;
      const bounds = storedRange(source, instrument.symbol, timeframe);
      if (bounds && rows[0].time <= bounds.min) return rows;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Fire-and-forget persistence of real exchange candles; errors are swallowed. */
  private persist(source: string, instrument: Instrument, timeframe: Timeframe, candles: Candle[]): void {
    try {
      // Belt-and-braces: drop anything not sourced from a real exchange feed.
      const real = candles.filter((c) => !c.source || !c.source.startsWith("Fallback"));
      if (real.length > 0) saveCandles(source, instrument.symbol, timeframe, real);
    } catch {
      // Never let a store write break the request path.
    }
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    options?: DataExchange | RouteOptions
  ): Promise<MarketSubscription> {
    const { exchange, strict } = normalizeOptions(options);
    const provider = this.primary(instrument, exchange);
    if (provider === this.synthetic) {
      if (strict) throw new Error(`No live feed for ${instrument.symbol} (synthetic disabled for trading)`);
      return this.synthetic.subscribe(instrument, timeframe, onCandle, onStatus);
    }

    try {
      return await provider.subscribe(instrument, timeframe, onCandle, onStatus);
    } catch (error) {
      if (strict) throw error;
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

/** Accept either a bare exchange string (legacy callers) or a RouteOptions object. */
function normalizeOptions(options?: DataExchange | RouteOptions): RouteOptions {
  if (!options) return {};
  if (typeof options === "string") return { exchange: options };
  return options;
}
