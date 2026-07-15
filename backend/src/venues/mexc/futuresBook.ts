import type { PublicDepthLevel } from "../publicTypes.js";
import type { MexcFuturesDepthMessage } from "./types.js";
import { exactString, instrumentId, nonNegative, positive, positiveMillis, record, safeInteger, unsignedBigInteger, validation } from "./validation.js";

export interface MexcFuturesBookView {
  status: "awaiting-snapshot" | "ready" | "invalidated";
  protocol: "mexc-futures-versioned-depth/v1";
  instrumentId: string;
  quantityUnit: "contract";
  sequence?: string;
  exchangeTs?: number;
  routeReady: boolean;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
  invalidReason?: string;
}

export interface MexcFuturesBookOptions {
  maxLevelsPerSide?: number;
  maxUpdatesPerMessage?: number;
}

export interface MexcFuturesBookAdvance {
  changed: boolean;
  sequence?: string;
  exchangeTs?: number;
  routeReady: boolean;
}

/** Pure reducer for the futures `push.depth` version+1 protocol; it is not the Spot PB protocol. */
export class MexcFuturesBookReconciler {
  private readonly id: string;
  private readonly maxLevels: number;
  private readonly maxUpdates: number;
  private status: MexcFuturesBookView["status"] = "awaiting-snapshot";
  private bids = new Map<number, PublicDepthLevel>();
  private asks = new Map<number, PublicDepthLevel>();
  private sequence?: bigint;
  private exchangeTs?: number;
  private bestBid?: number;
  private bestAsk?: number;
  private invalidReason?: string;

  constructor(instrumentIdValue: string, options: MexcFuturesBookOptions = {}) {
    this.id = instrumentId(instrumentIdValue, "instrumentId");
    this.maxLevels = safeInteger(options.maxLevelsPerSide ?? 1_000, "maxLevelsPerSide", 1, 5_000);
    this.maxUpdates = safeInteger(options.maxUpdatesPerMessage ?? 2_000, "maxUpdatesPerMessage", 1, 10_000);
  }

  seed(raw: unknown): MexcFuturesBookView {
    try {
      this.requireUsable();
      const row = record(raw, "futures REST snapshot");
      this.bids = snapshotLevels(row.bids, "snapshot.bids", this.maxLevels);
      this.asks = snapshotLevels(row.asks, "snapshot.asks", this.maxLevels);
      this.sequence = unsignedBigInteger(row.version, "snapshot.version");
      this.exchangeTs = positiveMillis(row.timestamp, "snapshot.timestamp");
      const bounds = validateBook(this.bids, this.asks, this.maxLevels, "REST snapshot");
      this.bestBid = bounds.bestBid;
      this.bestAsk = bounds.bestAsk;
      this.status = "ready";
      this.invalidReason = undefined;
      return this.snapshot();
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }

  apply(raw: MexcFuturesDepthMessage): MexcFuturesBookView {
    this.advance(raw);
    return this.snapshot();
  }

  /** Applies and validates one native version without sorting/materializing the deep book. */
  advance(raw: MexcFuturesDepthMessage): MexcFuturesBookAdvance {
    try {
      this.requireUsable();
      if (this.status !== "ready" || this.sequence === undefined) throw validation("futures delta requires a REST snapshot");
      const message = parseMessage(raw, this.id, this.maxUpdates);
      if (message.version <= this.sequence) return this.advanceResult(false);
      if (message.version !== this.sequence + 1n) {
        throw validation(`MEXC futures version gap: expected ${this.sequence + 1n}, received ${message.version}`);
      }
      applyLevels(this.bids, message.bids);
      applyLevels(this.asks, message.asks);
      const bestBid = updatedBest(this.bids, message.bids, this.bestBid, "bids");
      const bestAsk = updatedBest(this.asks, message.asks, this.bestAsk, "asks");
      validateBookBounds(this.bids, this.asks, this.maxLevels, bestBid, bestAsk, "futures delta");
      this.bestBid = bestBid;
      this.bestAsk = bestAsk;
      this.sequence = message.version;
      this.exchangeTs = message.exchangeTs;
      return this.advanceResult(true);
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }

  snapshot(): MexcFuturesBookView {
    return {
      status: this.status,
      protocol: "mexc-futures-versioned-depth/v1",
      instrumentId: this.id,
      quantityUnit: "contract",
      ...(this.sequence === undefined ? {} : { sequence: this.sequence.toString() }),
      ...(this.exchangeTs === undefined ? {} : { exchangeTs: this.exchangeTs }),
      routeReady: this.status === "ready",
      bids: sorted(this.bids, "bids"),
      asks: sorted(this.asks, "asks"),
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason })
    };
  }

  reset(reason = "connection generation changed"): MexcFuturesBookView {
    this.status = "awaiting-snapshot";
    this.bids.clear();
    this.asks.clear();
    this.sequence = undefined;
    this.exchangeTs = undefined;
    this.bestBid = undefined;
    this.bestAsk = undefined;
    this.invalidReason = exactString(reason, "reset reason").slice(0, 200);
    return this.snapshot();
  }

  private requireUsable(): void {
    if (this.status === "invalidated") throw validation("book is invalidated; reset and reacquire the REST snapshot");
  }

  private advanceResult(changed: boolean): MexcFuturesBookAdvance {
    return {
      changed,
      ...(this.sequence === undefined ? {} : { sequence: this.sequence.toString() }),
      ...(this.exchangeTs === undefined ? {} : { exchangeTs: this.exchangeTs }),
      routeReady: this.status === "ready"
    };
  }

  private invalidate(error: unknown): void {
    this.status = "invalidated";
    this.bids.clear();
    this.asks.clear();
    this.bestBid = undefined;
    this.bestAsk = undefined;
    this.invalidReason = (error instanceof Error ? error.message : "invalid MEXC futures depth message").slice(0, 300);
  }
}

export function mexcFuturesDepthSubscription(instrumentIdValue: string) {
  // MEXC documents `compress: true` as merged/zipped incremental pushes. Exact version+1 proof
  // requires every native JSON event, so the continuous reducer explicitly requests unmerged data.
  return { method: "sub.depth", param: { symbol: instrumentId(instrumentIdValue, "instrumentId"), compress: false } } as const;
}

function parseMessage(raw: MexcFuturesDepthMessage, id: string, maximum: number) {
  const envelope = record(raw, "futures depth message");
  if (exactString(envelope.channel, "message.channel") !== "push.depth") throw validation("message.channel must be push.depth");
  if (instrumentId(envelope.symbol, "message.symbol") !== id) throw validation("message symbol does not match reconciler instrument");
  const data = record(envelope.data, "message.data");
  const bids = updateLevels(data.bids, "message.data.bids");
  const asks = updateLevels(data.asks, "message.data.asks");
  if (bids.length + asks.length === 0) throw validation("futures depth message must contain an update");
  if (bids.length + asks.length > maximum) throw validation(`futures depth message exceeds ${maximum} updates`);
  return {
    version: unsignedBigInteger(data.version, "message.data.version"),
    exchangeTs: positiveMillis(envelope.ts, "message.ts"),
    bids,
    asks
  };
}

function snapshotLevels(value: unknown, label: string, maximum: number): Map<number, PublicDepthLevel> {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > maximum) throw validation(`${label} exceeds ${maximum} levels`);
  const result = new Map<number, PublicDepthLevel>();
  value.forEach((raw, index) => {
    const level = parseTuple(raw, `${label}[${index}]`, false);
    if (result.has(level[0])) throw validation(`${label} repeats price ${level[0]}`);
    result.set(level[0], level);
  });
  return result;
}

function updateLevels(value: unknown, label: string): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const seen = new Set<number>();
  return value.map((raw, index) => {
    const level = parseTuple(raw, `${label}[${index}]`, true);
    if (seen.has(level[0])) throw validation(`${label} repeats price ${level[0]}`);
    seen.add(level[0]);
    return level;
  });
}

function parseTuple(raw: unknown, label: string, allowZero: boolean): PublicDepthLevel {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) throw validation(`${label} must contain price, volume and optional order count`);
  const price = positive(raw[0], `${label}.price`);
  const quantity = allowZero ? nonNegative(raw[1], `${label}.quantity`) : positive(raw[1], `${label}.quantity`);
  if (raw[2] === undefined) return [price, quantity];
  return [price, quantity, safeInteger(raw[2], `${label}.orderCount`)];
}

function applyLevels(book: Map<number, PublicDepthLevel>, levels: readonly PublicDepthLevel[]): void {
  levels.forEach((level) => {
    if (level[1] === 0) book.delete(level[0]);
    else book.set(level[0], level);
  });
}

function validateBook(bids: Map<number, PublicDepthLevel>, asks: Map<number, PublicDepthLevel>, maximum: number, label: string) {
  if (bids.size === 0 || asks.size === 0) throw validation(`${label} requires both non-empty sides`);
  if (bids.size > maximum || asks.size > maximum) throw validation(`${label} exceeds ${maximum} levels per side`);
  const bestBid = Math.max(...bids.keys());
  const bestAsk = Math.min(...asks.keys());
  if (bestBid >= bestAsk) throw validation(`${label} is crossed or locked`);
  return { bestBid, bestAsk };
}

function validateBookBounds(
  bids: ReadonlyMap<number, PublicDepthLevel>,
  asks: ReadonlyMap<number, PublicDepthLevel>,
  maximum: number,
  bestBid: number | undefined,
  bestAsk: number | undefined,
  label: string
) {
  if (bids.size === 0 || asks.size === 0 || bestBid === undefined || bestAsk === undefined) throw validation(`${label} requires both non-empty sides`);
  if (bids.size > maximum || asks.size > maximum) throw validation(`${label} exceeds ${maximum} levels per side`);
  if (bestBid >= bestAsk) throw validation(`${label} is crossed or locked`);
}

function updatedBest<T>(book: ReadonlyMap<number, T>, levels: readonly PublicDepthLevel[], previous: number | undefined, side: "bids" | "asks") {
  let best = previous;
  let rescan = best === undefined;
  for (const [price, quantity] of levels) {
    if (quantity === 0) {
      if (price === best) rescan = true;
    } else if (best === undefined || (side === "bids" ? price > best : price < best)) {
      best = price;
    }
  }
  if (book.size === 0) return undefined;
  if (!rescan) return best;
  let resolved = side === "bids" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const price of book.keys()) resolved = side === "bids" ? Math.max(resolved, price) : Math.min(resolved, price);
  return resolved;
}

function sorted(book: Map<number, PublicDepthLevel>, side: "bids" | "asks"): PublicDepthLevel[] {
  return [...book.values()].sort((left, right) => (side === "bids" ? right[0] - left[0] : left[0] - right[0]));
}
