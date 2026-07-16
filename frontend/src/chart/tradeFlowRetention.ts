import type { TradeFlowTrade } from "../types";

/**
 * Fixed-capacity chronological trade deque. Incoming exchange batches are
 * chronological, so retention expiry and capacity eviction both operate from
 * the head without cloning the retained trade history.
 */
export class TradeFlowRetentionBuffer implements Iterable<TradeFlowTrade> {
  private readonly slots: Array<TradeFlowTrade | undefined>;
  private readonly seen = new Set<string>();
  private head = 0;
  private count = 0;
  private buy = 0;
  private sell = 0;

  constructor(
    readonly capacity: number,
    readonly retentionMs: number
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Trade retention capacity must be a positive integer");
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("Trade retention duration must be positive");
    this.slots = new Array(capacity);
  }

  get size() {
    return this.count;
  }

  get buyNotional() {
    return this.buy;
  }

  get sellNotional() {
    return this.sell;
  }

  append(trades: Iterable<TradeFlowTrade>, now: number) {
    const cutoff = now - this.retentionMs;
    this.expire(cutoff);
    let appended = 0;
    for (const trade of trades) {
      if (trade.exchangeTs < cutoff || this.seen.has(trade.id)) continue;
      if (this.count === this.capacity) this.removeHead();
      const index = (this.head + this.count) % this.capacity;
      this.slots[index] = trade;
      this.count += 1;
      this.seen.add(trade.id);
      this.addNotional(trade, 1);
      appended += 1;
    }
    return appended;
  }

  clear() {
    for (let index = 0; index < this.count; index += 1) {
      this.slots[(this.head + index) % this.capacity] = undefined;
    }
    this.seen.clear();
    this.head = 0;
    this.count = 0;
    this.buy = 0;
    this.sell = 0;
  }

  *[Symbol.iterator]() {
    for (let index = 0; index < this.count; index += 1) {
      const trade = this.slots[(this.head + index) % this.capacity];
      if (trade) yield trade;
    }
  }

  private expire(cutoff: number) {
    while (this.count > 0) {
      const oldest = this.slots[this.head];
      if (!oldest || oldest.exchangeTs >= cutoff) break;
      this.removeHead();
    }
  }

  private removeHead() {
    const trade = this.slots[this.head];
    if (trade) {
      this.seen.delete(trade.id);
      this.addNotional(trade, -1);
    }
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    if (this.count === 0) this.head = 0;
  }

  private addNotional(trade: TradeFlowTrade, direction: 1 | -1) {
    const notional = trade.price * trade.size * direction;
    if (trade.side === "buy") this.buy += notional;
    else this.sell += notional;
  }
}

/** Bounded last-seen window for deduplicating recurring insight candidates. */
export class RecentAlertIdWindow {
  private readonly ids = new Map<string, number>();

  constructor(
    readonly capacity: number,
    readonly retentionMs: number
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Alert ID capacity must be a positive integer");
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("Alert ID retention duration must be positive");
  }

  get size() {
    return this.ids.size;
  }

  rememberIfNew(id: string, now: number) {
    this.expire(now);
    const known = this.ids.has(id);
    if (known) this.ids.delete(id);
    this.ids.set(id, now);
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.keys().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
    return !known;
  }

  clear() {
    this.ids.clear();
  }

  private expire(now: number) {
    const cutoff = now - this.retentionMs;
    for (const [id, seenAt] of this.ids) {
      if (seenAt >= cutoff) break;
      this.ids.delete(id);
    }
  }
}
