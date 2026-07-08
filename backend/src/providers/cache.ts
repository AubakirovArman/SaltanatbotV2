import type { Candle } from "../types.js";

interface CacheEntry {
  candles: Candle[];
  expires: number;
}

/**
 * TTL cache for candle windows. Closed historical windows (endTime strictly in
 * the past) are immutable, so they are cached for a long time; windows that
 * include the forming bar get a short TTL so live data stays fresh.
 */
export class CandleCache {
  private store = new Map<string, CacheEntry>();

  constructor(
    private readonly liveTtlMs = 2_000,
    private readonly historyTtlMs = 10 * 60_000,
    private readonly maxEntries = 512
  ) {}

  get(key: string, now: number): Candle[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU ordering.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.candles;
  }

  set(key: string, candles: Candle[], now: number, isHistory: boolean) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      candles,
      expires: now + (isHistory ? this.historyTtlMs : this.liveTtlMs)
    });
  }
}
