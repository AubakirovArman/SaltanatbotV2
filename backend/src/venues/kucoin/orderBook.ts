import type { PublicDepthLevel } from "../publicTypes.js";
import type { KucoinMarketType, KucoinObuMessage } from "./types.js";
import { exactString, nanosToMillis, nonNegative, positive, record, safeInteger, unsignedBigInteger, validation, venueSymbol } from "./validation.js";

export const KUCOIN_OBU_DEPTH_MODE = "increment@10ms" as const;
export const KUCOIN_OBU_MAX_LEVELS = 500;

export interface KucoinObuBookView {
  status: "awaiting-snapshot" | "ready" | "invalidated";
  protocol: "kucoin-obu-increment-best-500/v1";
  instrumentId: string;
  marketType: KucoinMarketType;
  quantityUnit: "base" | "contract";
  sequence?: string;
  exchangeTs?: number;
  routeReady: boolean;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
  invalidReason?: string;
}

export interface KucoinObuBookOptions {
  maxLevelsPerSide?: number;
  maxUpdatesPerMessage?: number;
}

export interface KucoinObuBookAdvance {
  changed: boolean;
  sequence?: string;
  exchangeTs?: number;
  routeReady: boolean;
}

interface ParsedMessage {
  type: "snapshot" | "delta";
  sequenceStart: bigint;
  sequenceEnd: bigint;
  exchangeTs: number;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
}

/** Pure reducer for the post-retirement snapshot + delta `increment@10ms` channel. */
export class KucoinObuBookReconciler {
  private readonly instrumentId: string;
  private readonly marketType: KucoinMarketType;
  private readonly maxLevels: number;
  private readonly maxUpdates: number;
  private status: KucoinObuBookView["status"] = "awaiting-snapshot";
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sequence?: bigint;
  private exchangeTs?: number;
  private bestBid?: number;
  private bestAsk?: number;
  private invalidReason?: string;

  constructor(instrumentId: string, marketType: KucoinMarketType, options: KucoinObuBookOptions = {}) {
    this.instrumentId = venueSymbol(instrumentId, "instrumentId");
    this.marketType = marketType;
    this.maxLevels = safeInteger(options.maxLevelsPerSide ?? KUCOIN_OBU_MAX_LEVELS, "maxLevelsPerSide", 1);
    if (this.maxLevels > KUCOIN_OBU_MAX_LEVELS) throw validation(`maxLevelsPerSide cannot exceed ${KUCOIN_OBU_MAX_LEVELS}`);
    this.maxUpdates = safeInteger(options.maxUpdatesPerMessage ?? 1_000, "maxUpdatesPerMessage", 1);
    if (this.maxUpdates > 2_000) throw validation("maxUpdatesPerMessage cannot exceed 2000");
  }

  apply(raw: KucoinObuMessage): KucoinObuBookView {
    this.advance(raw);
    return this.snapshot();
  }

  /** Applies all continuity gates without sorting/materializing the retained book. */
  advance(raw: KucoinObuMessage): KucoinObuBookAdvance {
    try {
      if (this.status === "invalidated") throw validation("book is invalidated; reset and wait for a new snapshot");
      const message = parseMessage(raw, this.instrumentId, this.marketType, this.maxUpdates);
      let changed: boolean;
      if (message.type === "snapshot") {
        this.applySnapshot(message);
        changed = true;
      } else {
        changed = this.applyDelta(message);
      }
      return {
        changed,
        ...(this.sequence === undefined ? {} : { sequence: this.sequence.toString() }),
        ...(this.exchangeTs === undefined ? {} : { exchangeTs: this.exchangeTs }),
        routeReady: this.status === "ready"
      };
    } catch (error) {
      this.status = "invalidated";
      this.bids.clear();
      this.asks.clear();
      this.bestBid = undefined;
      this.bestAsk = undefined;
      this.invalidReason = (error instanceof Error ? error.message : "invalid KuCoin OBU message").slice(0, 300);
      throw error;
    }
  }

  snapshot(): KucoinObuBookView {
    return {
      status: this.status,
      protocol: "kucoin-obu-increment-best-500/v1",
      instrumentId: this.instrumentId,
      marketType: this.marketType,
      quantityUnit: this.marketType === "spot" ? "base" : "contract",
      ...(this.sequence === undefined ? {} : { sequence: this.sequence.toString() }),
      ...(this.exchangeTs === undefined ? {} : { exchangeTs: this.exchangeTs }),
      routeReady: this.status === "ready",
      bids: sorted(this.bids, "bids"),
      asks: sorted(this.asks, "asks"),
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason })
    };
  }

  reset(reason = "connection generation changed"): KucoinObuBookView {
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

  private applySnapshot(message: ParsedMessage): void {
    if (this.status !== "awaiting-snapshot") throw validation("unexpected replacement snapshot; reset the connection generation first");
    if (message.sequenceStart !== message.sequenceEnd) throw validation("snapshot requires O = C");
    const bids = new Map(message.bids.map(([price, quantity]) => [price, quantity]));
    const asks = new Map(message.asks.map(([price, quantity]) => [price, quantity]));
    const bounds = validateBook(bids, asks, this.maxLevels, "snapshot");
    this.bids = bids;
    this.asks = asks;
    this.sequence = message.sequenceEnd;
    this.exchangeTs = message.exchangeTs;
    this.bestBid = bounds.bestBid;
    this.bestAsk = bounds.bestAsk;
    this.status = "ready";
    this.invalidReason = undefined;
  }

  private applyDelta(message: ParsedMessage): boolean {
    if (this.status !== "ready" || this.sequence === undefined) throw validation("delta received before an increment@10ms snapshot");
    if (message.sequenceEnd <= this.sequence) return false;
    if (message.sequenceStart > this.sequence + 1n) {
      throw validation(`sequence gap: expected O <= ${this.sequence + 1n}, received ${message.sequenceStart}`);
    }
    if (this.exchangeTs !== undefined && message.exchangeTs < this.exchangeTs) {
      throw validation(`matching-engine timestamp regressed from ${this.exchangeTs} to ${message.exchangeTs}`);
    }
    applyLevels(this.bids, message.bids);
    applyLevels(this.asks, message.asks);
    const bestBid = updatedBest(this.bids, message.bids, this.bestBid, "bids");
    const bestAsk = updatedBest(this.asks, message.asks, this.bestAsk, "asks");
    validateBookBounds(this.bids, this.asks, this.maxLevels, bestBid, bestAsk, "delta");
    this.bestBid = bestBid;
    this.bestAsk = bestAsk;
    this.sequence = message.sequenceEnd;
    this.exchangeTs = message.exchangeTs;
    return true;
  }
}

export function kucoinObuSubscription(id: string, instrumentId: string, marketType: KucoinMarketType) {
  const requestId = exactString(id, "subscription id");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(requestId)) throw validation("subscription id must use public-channel characters and contain at most 40 characters");
  return {
    id: requestId,
    action: "SUBSCRIBE",
    channel: "obu",
    tradeType: marketType === "spot" ? "SPOT" : "FUTURES",
    symbol: venueSymbol(instrumentId, "instrumentId"),
    depth: KUCOIN_OBU_DEPTH_MODE,
    rpiFilter: 0
  } as const;
}

function parseMessage(raw: KucoinObuMessage, instrumentId: string, marketType: KucoinMarketType, maxUpdates: number): ParsedMessage {
  const envelope = record(raw, "OBU message");
  const expectedTopic = marketType === "spot" ? "obu.SPOT" : "obu.FUTURES";
  if (exactString(envelope.T, "OBU.T") !== expectedTopic) throw validation(`OBU.T must be ${expectedTopic}`);
  if (exactString(envelope.dp, "OBU.dp") !== KUCOIN_OBU_DEPTH_MODE) {
    throw validation(`OBU.dp must be ${KUCOIN_OBU_DEPTH_MODE}; retired increment mode is forbidden`);
  }
  const type = exactString(envelope.t, "OBU.t");
  if (type !== "snapshot" && type !== "delta") throw validation("OBU.t must be snapshot or delta");
  const data = record(envelope.d, "OBU.d");
  if (venueSymbol(data.s, "OBU.d.s") !== instrumentId) throw validation("OBU symbol does not match reconciler instrument");
  const sequenceStart = unsignedBigInteger(data.O, "OBU.d.O");
  const sequenceEnd = unsignedBigInteger(data.C, "OBU.d.C");
  if (sequenceStart > sequenceEnd) throw validation("OBU sequence start cannot exceed sequence end");
  const bids = updateLevels(data.b, "OBU.d.b", type === "snapshot");
  const asks = updateLevels(data.a, "OBU.d.a", type === "snapshot");
  if (bids.length + asks.length > maxUpdates) throw validation(`OBU message exceeds ${maxUpdates} price updates`);
  return { type, sequenceStart, sequenceEnd, exchangeTs: nanosToMillis(data.M, "OBU.d.M"), bids, asks };
}

function updateLevels(value: unknown, label: string, snapshot: boolean): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const seen = new Set<number>();
  return value.map((raw, index): PublicDepthLevel => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) throw validation(`${label}[${index}] must contain price, size and optional RPI flag`);
    const price = positive(raw[0], `${label}[${index}].price`);
    const quantity = nonNegative(raw[1], `${label}[${index}].quantity`);
    if (snapshot && quantity === 0) throw validation(`${label} snapshot cannot contain zero-size levels`);
    if (seen.has(price)) throw validation(`${label} repeats price ${price}`);
    seen.add(price);
    return [price, quantity];
  });
}

function applyLevels(book: Map<number, number>, levels: readonly PublicDepthLevel[]): void {
  levels.forEach(([price, quantity]) => {
    if (quantity === 0) book.delete(price);
    else book.set(price, quantity);
  });
}

function validateBook(bids: Map<number, number>, asks: Map<number, number>, maximum: number, label: string) {
  if (bids.size === 0 || asks.size === 0) throw validation(`${label} requires both non-empty sides`);
  if (bids.size > maximum || asks.size > maximum) throw validation(`${label} exceeds ${maximum} levels per side`);
  const bestBid = Math.max(...bids.keys());
  const bestAsk = Math.min(...asks.keys());
  if (bestBid >= bestAsk) throw validation(`${label} is crossed or locked`);
  return { bestBid, bestAsk };
}

function validateBookBounds(bids: ReadonlyMap<number, number>, asks: ReadonlyMap<number, number>, maximum: number, bestBid: number | undefined, bestAsk: number | undefined, label: string) {
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

function sorted(book: Map<number, number>, side: "bids" | "asks"): PublicDepthLevel[] {
  return [...book.entries()].sort(([left], [right]) => (side === "bids" ? right - left : left - right)).map(([price, quantity]) => [price, quantity] as const);
}
