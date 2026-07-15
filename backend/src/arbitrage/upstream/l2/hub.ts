import type { ArbitrageExchange, ArbitrageMarket } from "../../types.js";
import { SequenceVerifiedL2Feed } from "./feed.js";
import type { SequenceVerifiedBookProvider, SequenceVerifiedL2Book, SequenceVerifiedL2Callbacks, SequenceVerifiedL2Subscription } from "./types.js";

const DEFAULT_MAX_BOOKS = 16;
const DEFAULT_MAX_WAITERS = 64;

interface ManagedFeed extends SequenceVerifiedL2Subscription {
  start(): void;
}

type FeedFactory = (
  exchange: ArbitrageExchange,
  market: ArbitrageMarket,
  symbol: string,
  callbacks: SequenceVerifiedL2Callbacks
) => ManagedFeed;

interface Waiter {
  resolve(book: SequenceVerifiedL2Book): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Entry {
  feed: ManagedFeed;
  waiters: Set<Waiter>;
  book?: SequenceVerifiedL2Book;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
}

interface SequenceVerifiedL2HubOptions {
  feedFactory?: FeedFactory;
  now?: () => number;
  maxBooks?: number;
  maxWaiters?: number;
  maxBookAgeMs?: number;
  waitTimeoutMs?: number;
  idleTtlMs?: number;
}

/** Bounded, on-demand sharing for the strict L2 path used by arbitrage depth analysis. */
export class SequenceVerifiedL2Hub implements SequenceVerifiedBookProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly feedFactory: FeedFactory;
  private readonly now: () => number;
  private readonly maxBooks: number;
  private readonly maxWaiters: number;
  private readonly maxBookAgeMs: number;
  private readonly waitTimeoutMs: number;
  private readonly idleTtlMs: number;
  private waiterCount = 0;

  constructor(options: SequenceVerifiedL2HubOptions = {}) {
    this.feedFactory = options.feedFactory ?? ((exchange, market, symbol, callbacks) => new SequenceVerifiedL2Feed(exchange, market, symbol, callbacks));
    this.now = options.now ?? Date.now;
    this.maxBooks = boundedOption(options.maxBooks ?? DEFAULT_MAX_BOOKS, 1, 128, "maxBooks");
    this.maxWaiters = boundedOption(options.maxWaiters ?? DEFAULT_MAX_WAITERS, 1, 1_000, "maxWaiters");
    this.maxBookAgeMs = boundedOption(options.maxBookAgeMs ?? 10_000, 1, 60_000, "maxBookAgeMs");
    this.waitTimeoutMs = boundedOption(options.waitTimeoutMs ?? 10_000, 1, 60_000, "waitTimeoutMs");
    this.idleTtlMs = boundedOption(options.idleTtlMs ?? 30_000, 1, 300_000, "idleTtlMs");
  }

  async getBook(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, signal?: AbortSignal): Promise<SequenceVerifiedL2Book> {
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (!/^[A-Z0-9-]{2,32}$/.test(symbol)) throw new Error("Invalid L2 book symbol");
    const key = `${exchange}:${market}:${symbol}`;
    let entry = this.entries.get(key);
    if (entry?.book && this.now() - entry.book.receivedAt <= this.maxBookAgeMs) {
      entry.lastUsedAt = this.now();
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      this.scheduleIdle(key, entry);
      return cloneBook(entry.book);
    }
    if (this.waiterCount >= this.maxWaiters) throw new Error(`Sequence-verified L2 waiter limit reached (${this.maxWaiters})`);
    entry ??= this.createEntry(key, exchange, market, symbol);
    entry.lastUsedAt = this.now();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (entry.book && this.now() - entry.book.receivedAt <= this.maxBookAgeMs) {
      this.scheduleIdle(key, entry);
      return cloneBook(entry.book);
    }
    return await new Promise<SequenceVerifiedL2Book>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(key, entry, waiter);
          reject(new Error(`Timed out waiting for sequence-verified L2 ${key}`));
        }, this.waitTimeoutMs),
        ...(signal ? { signal } : {})
      };
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(key, entry, waiter);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      entry.waiters.add(waiter);
      this.waiterCount += 1;
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  activeBooks() {
    return this.entries.size;
  }

  isCurrent(book: SequenceVerifiedL2Book) {
    const entry = this.entries.get(`${book.exchange}:${book.market}:${book.symbol}`);
    const current = entry?.book;
    return Boolean(
      current &&
        validManagedBook(book, book.exchange, book.market, book.symbol) &&
        current.connectionGeneration === book.connectionGeneration &&
        current.sequence === book.sequence &&
        current.receivedAt === book.receivedAt &&
        current.exchangeTs === book.exchangeTs &&
        this.now() - current.receivedAt <= this.maxBookAgeMs
    );
  }

  close() {
    for (const [key, entry] of this.entries) this.disposeEntry(key, entry, new Error("Sequence-verified L2 hub closed"));
  }

  private createEntry(key: string, exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string) {
    this.evictIdleEntry();
    if (this.entries.size >= this.maxBooks) throw new Error(`Sequence-verified L2 stream limit reached (${this.maxBooks})`);
    let entry: Entry;
    const feed = this.feedFactory(exchange, market, symbol, {
      onBook: (book) => {
        if (this.entries.get(key) !== entry) return;
        if (!validManagedBook(book, exchange, market, symbol)) {
          entry.book = undefined;
          const error = new Error(`Invalid sequence-verified L2 publication for ${key}`);
          for (const waiter of [...entry.waiters]) {
            this.removeWaiter(key, entry, waiter);
            waiter.reject(error);
          }
          return;
        }
        entry.book = cloneBook(book);
        entry.lastUsedAt = this.now();
        const waiters = [...entry.waiters];
        for (const waiter of waiters) {
          this.removeWaiter(key, entry, waiter);
          waiter.resolve(cloneBook(book));
        }
      },
      onInvalidate: () => {
        if (this.entries.get(key) === entry) entry.book = undefined;
      },
      onStatus: () => undefined
    });
    entry = { feed, waiters: new Set(), lastUsedAt: this.now() };
    this.entries.set(key, entry);
    try {
      feed.start();
    } catch (error) {
      this.entries.delete(key);
      feed.close();
      throw error;
    }
    return entry;
  }

  private removeWaiter(key: string, entry: Entry, waiter: Waiter) {
    if (!entry.waiters.delete(waiter)) return;
    this.waiterCount -= 1;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.scheduleIdle(key, entry);
  }

  private scheduleIdle(key: string, entry: Entry) {
    if (entry.waiters.size > 0 || entry.idleTimer || this.entries.get(key) !== entry) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.waiters.size === 0 && this.entries.get(key) === entry) this.disposeEntry(key, entry);
    }, this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private evictIdleEntry() {
    if (this.entries.size < this.maxBooks) return;
    const candidate = [...this.entries.entries()]
      .filter(([, entry]) => entry.waiters.size === 0)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (candidate) this.disposeEntry(candidate[0], candidate[1]);
  }

  private disposeEntry(key: string, entry: Entry, error = new Error("Sequence-verified L2 feed disposed")) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    for (const waiter of [...entry.waiters]) {
      this.removeWaiter(key, entry, waiter);
      waiter.reject(error);
    }
    entry.feed.close();
  }
}

export const sequenceVerifiedL2Hub = new SequenceVerifiedL2Hub();

function cloneBook(book: SequenceVerifiedL2Book): SequenceVerifiedL2Book {
  return { ...book, bids: book.bids.map(([price, quantity]) => [price, quantity]), asks: book.asks.map(([price, quantity]) => [price, quantity]) };
}

function validManagedBook(book: SequenceVerifiedL2Book, exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string) {
  return (
    book.exchange === exchange &&
    book.market === market &&
    book.symbol === symbol &&
    book.sequenceVerified === true &&
    book.source === "websocket-reconstructed" &&
    Number.isSafeInteger(book.connectionGeneration) &&
    (book.connectionGeneration ?? 0) > 0 &&
    Number.isSafeInteger(book.sequence) &&
    book.sequence > 0 &&
    Number.isSafeInteger(book.exchangeTs) &&
    book.exchangeTs > 0 &&
    Number.isSafeInteger(book.receivedAt) &&
    book.receivedAt > 0
  );
}

function boundedOption(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}
