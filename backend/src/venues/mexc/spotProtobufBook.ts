import type { PublicDepthLevel } from "../publicTypes.js";
import type { MexcSpotProtobufDepthEnvelope } from "./types.js";
import { exactString, instrumentId, nonNegative, positive, positiveMillis, record, safeInteger, unsignedBigInteger, validation } from "./validation.js";

export const MEXC_SPOT_PUBLIC_WS_URL = "wss://wbs-api.mexc.com/ws" as const;
export const MEXC_SPOT_DEPTH_CHANNEL = "spot@public.aggre.depth.v3.api.pb@10ms" as const;

export interface MexcSpotBookView {
  status: "awaiting-snapshot" | "ready" | "invalidated";
  protocol: "mexc-spot-protobuf-depth/v1";
  instrumentId: string;
  quantityUnit: "base";
  sequence?: string;
  exchangeTs?: number;
  routeReady: boolean;
  boundedSnapshot: true;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
  bufferedMessages: number;
  invalidReason?: string;
}

export interface MexcSpotBookOptions {
  maxLevelsPerSide?: number;
  maxUpdatesPerMessage?: number;
  maxBufferedMessages?: number;
  maxBufferedLevelUpdates?: number;
}

interface ParsedDelta {
  fromVersion: bigint;
  toVersion: bigint;
  exchangeTs: number;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
}

/**
 * Reconciles decoded MEXC Protobuf wrappers. Binary decoding must use MEXC's published `.proto`
 * files before calling this class; accepting legacy JSON frames here is intentionally unsupported.
 */
export class MexcSpotProtobufBookReconciler {
  private readonly id: string;
  private readonly maxLevels: number;
  private readonly maxUpdates: number;
  private readonly maxBuffered: number;
  private readonly maxBufferedUpdates: number;
  private status: MexcSpotBookView["status"] = "awaiting-snapshot";
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sequence?: bigint;
  private exchangeTs?: number;
  private buffer: ParsedDelta[] = [];
  private bufferedUpdates = 0;
  private invalidReason?: string;

  constructor(instrumentIdValue: string, options: MexcSpotBookOptions = {}) {
    this.id = instrumentId(instrumentIdValue, "instrumentId");
    this.maxLevels = safeInteger(options.maxLevelsPerSide ?? 1_000, "maxLevelsPerSide", 1, 5_000);
    this.maxUpdates = safeInteger(options.maxUpdatesPerMessage ?? 2_000, "maxUpdatesPerMessage", 1, 10_000);
    this.maxBuffered = safeInteger(options.maxBufferedMessages ?? 1_000, "maxBufferedMessages", 1, 5_000);
    this.maxBufferedUpdates = safeInteger(options.maxBufferedLevelUpdates ?? 20_000, "maxBufferedLevelUpdates", 1, 100_000);
  }

  ingestDecoded(raw: MexcSpotProtobufDepthEnvelope): MexcSpotBookView {
    try {
      this.requireUsable();
      const message = parseDelta(raw, this.id, this.maxUpdates);
      if (this.status === "awaiting-snapshot") {
        if (this.buffer.length >= this.maxBuffered) throw validation(`Protobuf delta buffer exceeds ${this.maxBuffered} messages`);
        const updates = message.bids.length + message.asks.length;
        if (this.bufferedUpdates + updates > this.maxBufferedUpdates) throw validation(`Protobuf delta buffer exceeds ${this.maxBufferedUpdates} level updates`);
        this.buffer.push(message);
        this.bufferedUpdates += updates;
      } else {
        this.applyDelta(message);
      }
      return this.snapshot();
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }

  seed(raw: unknown, receivedAt: number): MexcSpotBookView {
    try {
      this.requireUsable();
      const snapshot = parseRestSnapshot(raw, this.maxLevels);
      this.bids = snapshot.bids;
      this.asks = snapshot.asks;
      this.sequence = snapshot.sequence;
      this.exchangeTs = positiveMillis(receivedAt, "receivedAt");
      this.status = "ready";
      for (const delta of this.buffer) this.applyDelta(delta, true);
      this.buffer = [];
      this.bufferedUpdates = 0;
      validateBook(this.bids, this.asks, this.maxLevels, "seeded book");
      this.invalidReason = undefined;
      return this.snapshot();
    } catch (error) {
      this.invalidate(error);
      throw error;
    }
  }

  snapshot(): MexcSpotBookView {
    return {
      status: this.status,
      protocol: "mexc-spot-protobuf-depth/v1",
      instrumentId: this.id,
      quantityUnit: "base",
      ...(this.sequence === undefined ? {} : { sequence: this.sequence.toString() }),
      ...(this.exchangeTs === undefined ? {} : { exchangeTs: this.exchangeTs }),
      routeReady: this.status === "ready",
      boundedSnapshot: true,
      bids: sorted(this.bids, "bids"),
      asks: sorted(this.asks, "asks"),
      bufferedMessages: this.buffer.length,
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason })
    };
  }

  reset(reason = "connection generation changed"): MexcSpotBookView {
    this.status = "awaiting-snapshot";
    this.bids.clear();
    this.asks.clear();
    this.sequence = undefined;
    this.exchangeTs = undefined;
    this.buffer = [];
    this.bufferedUpdates = 0;
    this.invalidReason = exactString(reason, "reset reason").slice(0, 200);
    return this.snapshot();
  }

  private applyDelta(message: ParsedDelta, replaying = false): void {
    if (this.status !== "ready" || this.sequence === undefined) throw validation("MEXC Spot delta requires a REST snapshot");
    if (message.toVersion < this.sequence || message.toVersion === this.sequence) return;
    const expected = this.sequence + 1n;
    const bridgesSnapshot = replaying && message.fromVersion <= this.sequence && message.toVersion >= this.sequence;
    if (!bridgesSnapshot && message.fromVersion !== expected) {
      throw validation(`MEXC Spot version gap: expected fromVersion ${expected}, received ${message.fromVersion}`);
    }
    const bids = new Map(this.bids);
    const asks = new Map(this.asks);
    applyLevels(bids, message.bids);
    applyLevels(asks, message.asks);
    validateBook(bids, asks, this.maxLevels, "Protobuf delta");
    this.bids = bids;
    this.asks = asks;
    this.sequence = message.toVersion;
    this.exchangeTs = message.exchangeTs;
  }

  private requireUsable(): void {
    if (this.status === "invalidated") throw validation("book is invalidated; reset and reacquire the REST snapshot");
  }

  private invalidate(error: unknown): void {
    this.status = "invalidated";
    this.invalidReason = (error instanceof Error ? error.message : "invalid MEXC Spot depth message").slice(0, 300);
  }
}

export function mexcSpotDepthSubscription(instrumentIdValue: string) {
  return {
    method: "SUBSCRIPTION",
    params: [`${MEXC_SPOT_DEPTH_CHANNEL}@${instrumentId(instrumentIdValue, "instrumentId")}`]
  } as const;
}

function parseDelta(raw: MexcSpotProtobufDepthEnvelope, id: string, maximum: number): ParsedDelta {
  const envelope = record(raw, "decoded Protobuf wrapper");
  const channel = exactString(envelope.channel, "wrapper.channel");
  if (channel !== `${MEXC_SPOT_DEPTH_CHANNEL}@${id}` && channel !== `spot@public.aggre.depth.v3.api.pb@100ms@${id}`) {
    throw validation("wrapper.channel must be the documented MEXC Protobuf aggregate-depth channel");
  }
  if (instrumentId(envelope.symbol, "wrapper.symbol") !== id) throw validation("wrapper symbol does not match reconciler instrument");
  const data = record(envelope.publicAggreDepths, "wrapper.publicAggreDepths");
  const eventType = exactString(data.eventType, "depth.eventType");
  if (eventType !== MEXC_SPOT_DEPTH_CHANNEL && eventType !== "spot@public.aggre.depth.v3.api.pb@100ms") {
    throw validation("depth.eventtype is not a supported Protobuf aggregate-depth event");
  }
  const fromVersion = unsignedBigInteger(data.fromVersion, "depth.fromVersion");
  const toVersion = unsignedBigInteger(data.toVersion, "depth.toVersion");
  if (fromVersion > toVersion) throw validation("depth.fromVersion cannot exceed toVersion");
  const bids = protobufLevels(data.bids, "depth.bids");
  const asks = protobufLevels(data.asks, "depth.asks");
  if (bids.length + asks.length === 0) throw validation("Protobuf depth event must contain at least one update");
  if (bids.length + asks.length > maximum) throw validation(`Protobuf depth event exceeds ${maximum} updates`);
  return { fromVersion, toVersion, exchangeTs: positiveMillis(envelope.sendTime, "wrapper.sendTime"), bids, asks };
}

function parseRestSnapshot(raw: unknown, maximum: number): { sequence: bigint; bids: Map<number, number>; asks: Map<number, number> } {
  const row = record(raw, "REST depth snapshot");
  const bids = snapshotLevels(row.bids, "snapshot.bids", maximum);
  const asks = snapshotLevels(row.asks, "snapshot.asks", maximum);
  validateBook(bids, asks, maximum, "REST snapshot");
  return { sequence: unsignedBigInteger(row.lastUpdateId, "snapshot.lastUpdateId"), bids, asks };
}

function protobufLevels(value: unknown, label: string): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const seen = new Set<number>();
  return value.map((raw, index): PublicDepthLevel => {
    const row = record(raw, `${label}[${index}]`);
    const price = positive(row.price, `${label}[${index}].price`);
    const quantity = nonNegative(row.quantity, `${label}[${index}].quantity`);
    if (seen.has(price)) throw validation(`${label} repeats price ${price}`);
    seen.add(price);
    return [price, quantity];
  });
}

function snapshotLevels(value: unknown, label: string, maximum: number): Map<number, number> {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > maximum) throw validation(`${label} exceeds ${maximum} levels`);
  const result = new Map<number, number>();
  value.forEach((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
    const price = positive(raw[0], `${label}[${index}].price`);
    if (result.has(price)) throw validation(`${label} repeats price ${price}`);
    result.set(price, positive(raw[1], `${label}[${index}].quantity`));
  });
  return result;
}

function applyLevels(book: Map<number, number>, levels: readonly PublicDepthLevel[]): void {
  levels.forEach(([price, quantity]) => {
    if (quantity === 0) book.delete(price);
    else book.set(price, quantity);
  });
}

function validateBook(bids: Map<number, number>, asks: Map<number, number>, maximum: number, label: string): void {
  if (bids.size === 0 || asks.size === 0) throw validation(`${label} requires both non-empty sides`);
  if (bids.size > maximum || asks.size > maximum) throw validation(`${label} exceeds ${maximum} levels per side`);
  if (Math.max(...bids.keys()) >= Math.min(...asks.keys())) throw validation(`${label} is crossed or locked`);
}

function sorted(book: Map<number, number>, side: "bids" | "asks"): PublicDepthLevel[] {
  return [...book.entries()].sort(([left], [right]) => (side === "bids" ? right - left : left - right)).map(([price, quantity]) => [price, quantity] as const);
}
