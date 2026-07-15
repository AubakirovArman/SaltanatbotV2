import type { DydxIndexerBookMessage, DydxIndexerBookView, DydxIndexerPriceLevelUpdate } from "./types.js";
import { dydxValidation, nonNegative, positive, safeInteger, text, ticker } from "./validation.js";

interface StoredLevel {
  price: number;
  size: number;
  offset: bigint;
}

export interface DydxIndexerBookReconcilerOptions {
  maxLevelsPerSide?: number;
  maxUpdatesPerMessage?: number;
}

/**
 * Pure unbatched `v4_orderbook` reducer. Contiguous message IDs prove only local
 * subscription order; the resulting Indexer view remains non-canonical research data.
 */
export class DydxIndexerBookReconciler {
  private readonly instrumentId: string;
  private readonly maxLevelsPerSide: number;
  private readonly maxUpdatesPerMessage: number;
  private bids = new Map<number, StoredLevel>();
  private asks = new Map<number, StoredLevel>();
  private status: DydxIndexerBookView["status"] = "awaiting-snapshot";
  private connectionId?: string;
  private lastMessageId?: number;
  private invalidReason?: string;

  constructor(instrumentId: string, options: DydxIndexerBookReconcilerOptions = {}) {
    this.instrumentId = ticker(instrumentId, "instrumentId");
    this.maxLevelsPerSide = safeInteger(options.maxLevelsPerSide ?? 5_000, "maxLevelsPerSide", 1, 10_000);
    this.maxUpdatesPerMessage = safeInteger(options.maxUpdatesPerMessage ?? 2_000, "maxUpdatesPerMessage", 1, 10_000);
  }

  apply(message: DydxIndexerBookMessage): DydxIndexerBookView {
    try {
      this.validateEnvelope(message);
      if (message.type === "subscribed") this.applySnapshot(message);
      else this.applyUpdate(message);
      return this.snapshot();
    } catch (error) {
      this.invalidate(error instanceof Error ? error.message : "invalid Indexer book message");
      throw error;
    }
  }

  snapshot(): DydxIndexerBookView {
    const rawBids = sorted(this.bids, "bid");
    const rawAsks = sorted(this.asks, "ask");
    const rawCrossed = Boolean(rawBids[0] && rawAsks[0] && rawBids[0].price >= rawAsks[0].price);
    const { bids, asks } = uncross(rawBids, rawAsks);
    const uncrossed = !bids[0] || !asks[0] || bids[0].price < asks[0].price;
    return {
      status: this.status,
      instrumentId: this.instrumentId,
      ...(this.connectionId === undefined ? {} : { connectionId: this.connectionId }),
      ...(this.lastMessageId === undefined ? {} : { lastMessageId: this.lastMessageId }),
      sequenceVerified: this.status === "ready",
      canonical: false,
      routeReady: false,
      executionStatus: "research-only",
      rawCrossed,
      uncrossed,
      bids: bids.map((level) => [level.price, level.size, level.offset.toString()] as const),
      asks: asks.map((level) => [level.price, level.size, level.offset.toString()] as const),
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason })
    };
  }

  reset(reason = "stream generation changed"): DydxIndexerBookView {
    this.bids.clear();
    this.asks.clear();
    this.connectionId = undefined;
    this.lastMessageId = undefined;
    this.invalidReason = text(reason, "reset reason", 200);
    this.status = "awaiting-snapshot";
    return this.snapshot();
  }

  private validateEnvelope(message: DydxIndexerBookMessage): void {
    if (!message || typeof message !== "object") throw dydxValidation("Indexer book message must be an object");
    if (message.type !== "subscribed" && message.type !== "channel_data") {
      throw dydxValidation("Indexer book message type must be subscribed or channel_data");
    }
    if (ticker(message.instrumentId, "message instrumentId") !== this.instrumentId) {
      throw dydxValidation("Indexer book message instrument mismatch");
    }
    connectionToken(message.connectionId);
    safeInteger(message.messageId, "messageId", 0);
  }

  private applySnapshot(message: DydxIndexerBookMessage): void {
    if (!message.bids || !message.asks) throw dydxValidation("subscribed message requires bids and asks");
    const bids = buildSnapshotSide(message.bids, "bids", message.messageId, this.maxLevelsPerSide);
    const asks = buildSnapshotSide(message.asks, "asks", message.messageId, this.maxLevelsPerSide);
    if (bids.size === 0 || asks.size === 0) throw dydxValidation("subscribed message requires non-empty bids and asks");
    this.bids = bids;
    this.asks = asks;
    this.connectionId = message.connectionId;
    this.lastMessageId = message.messageId;
    this.invalidReason = undefined;
    this.status = "ready";
  }

  private applyUpdate(message: DydxIndexerBookMessage): void {
    if (this.status !== "ready" || this.connectionId === undefined || this.lastMessageId === undefined) {
      throw dydxValidation("channel_data received before a valid subscribed snapshot");
    }
    if (message.connectionId !== this.connectionId) throw dydxValidation("Indexer connection changed before a new snapshot");
    if (message.messageId !== this.lastMessageId + 1) {
      throw dydxValidation(`Indexer message-id gap: expected ${this.lastMessageId + 1}, received ${message.messageId}`);
    }
    const updateCount = (message.bids?.length ?? 0) + (message.asks?.length ?? 0);
    if (updateCount === 0) throw dydxValidation("channel_data must contain at least one book update");
    if (updateCount > this.maxUpdatesPerMessage) {
      throw dydxValidation(`channel_data exceeds ${this.maxUpdatesPerMessage} updates`);
    }
    const nextBids = new Map(this.bids);
    const nextAsks = new Map(this.asks);
    applyUpdates(nextBids, message.bids ?? [], "bids", message.messageId);
    applyUpdates(nextAsks, message.asks ?? [], "asks", message.messageId);
    if (nextBids.size > this.maxLevelsPerSide || nextAsks.size > this.maxLevelsPerSide) {
      throw dydxValidation(`Indexer book exceeds ${this.maxLevelsPerSide} levels per side`);
    }
    this.bids = nextBids;
    this.asks = nextAsks;
    this.lastMessageId = message.messageId;
  }

  private invalidate(reason: string): void {
    this.status = "invalidated";
    this.invalidReason = reason.slice(0, 300);
  }
}

function buildSnapshotSide(updates: readonly DydxIndexerPriceLevelUpdate[], label: string, messageId: number, maximum: number): Map<number, StoredLevel> {
  if (updates.length > maximum) throw dydxValidation(`${label} snapshot exceeds ${maximum} levels`);
  const side = new Map<number, StoredLevel>();
  applyUpdates(side, updates, label, messageId, true);
  return side;
}

function applyUpdates(side: Map<number, StoredLevel>, updates: readonly DydxIndexerPriceLevelUpdate[], label: string, messageId: number, snapshot = false): void {
  const seen = new Set<number>();
  updates.forEach((raw, index) => {
    const level = parseLevel(raw, `${label}[${index}]`, messageId);
    if (seen.has(level.price)) throw dydxValidation(`${label} repeats price ${level.price} in one message`);
    seen.add(level.price);
    if (level.size === 0) {
      if (snapshot) throw dydxValidation(`${label} snapshot cannot contain zero-size levels`);
      side.delete(level.price);
    } else {
      side.set(level.price, level);
    }
  });
}

function parseLevel(raw: DydxIndexerPriceLevelUpdate, label: string, messageId: number): StoredLevel {
  if (Array.isArray(raw)) {
    const tuple = raw as readonly [string | number, string | number, (string | number)?];
    if (tuple.length < 2 || tuple.length > 3) throw dydxValidation(`${label} tuple must contain price, size and optional offset`);
    return {
      price: positive(tuple[0], `${label}.price`),
      size: nonNegative(tuple[1], `${label}.size`),
      offset: logicalOffset(tuple[2] ?? messageId, `${label}.offset`)
    };
  }
  if (!raw || typeof raw !== "object") throw dydxValidation(`${label} must be an object or tuple`);
  const objectLevel = raw as { price: string | number; size: string | number; offset?: string | number };
  return {
    price: positive(objectLevel.price, `${label}.price`),
    size: nonNegative(objectLevel.size, `${label}.size`),
    offset: logicalOffset(objectLevel.offset ?? messageId, `${label}.offset`)
  };
}

function logicalOffset(value: string | number, label: string): bigint {
  if (typeof value === "number") return BigInt(safeInteger(value, label, 0));
  if (!/^\d{1,30}$/.test(value)) throw dydxValidation(`${label} must be a non-negative integer string up to 30 digits`);
  return BigInt(value);
}

function sorted(values: Map<number, StoredLevel>, side: "bid" | "ask"): StoredLevel[] {
  return [...values.values()].sort((left, right) => (side === "bid" ? right.price - left.price : left.price - right.price));
}

function uncross(inputBids: readonly StoredLevel[], inputAsks: readonly StoredLevel[]) {
  const bids = inputBids.map((level) => ({ ...level }));
  const asks = inputAsks.map((level) => ({ ...level }));
  while (bids[0] && asks[0] && bids[0].price >= asks[0].price) {
    const bid = bids[0];
    const ask = asks[0];
    if (bid.offset < ask.offset) bids.shift();
    else if (ask.offset < bid.offset) asks.shift();
    else if (bid.size > ask.size) {
      bid.size -= ask.size;
      asks.shift();
    } else if (ask.size > bid.size) {
      ask.size -= bid.size;
      bids.shift();
    } else {
      bids.shift();
      asks.shift();
    }
  }
  return { bids, asks };
}

function connectionToken(value: string): string {
  const normalized = text(value, "connectionId", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) throw dydxValidation("connectionId has invalid format");
  return normalized;
}
