import type WebSocket from "ws";
import { ContinuousBoundedBook, finite, record, safeInteger, validReceivedAt } from "./bookState.js";
import { KrakenSpotChecksumBook, parseKrakenSpotJson, type KrakenSpotLevelInput } from "./krakenSpotChecksum.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const MAX_LEVELS_PER_MESSAGE = 5_000;
const SPOT_DEPTHS = new Set([10, 25, 100, 500, 1_000]);

/** Kraken Spot v2 book with lossless decimal decoding and CRC32 verification on every publication. */
export class KrakenSpotContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://ws.kraken.com/v2";
  readonly needsBootstrap = false;
  private readonly depth: 10 | 25 | 100 | 500 | 1_000;
  private readonly book: KrakenSpotChecksumBook;
  private updateOrdinal = 0;
  private exchangeTs?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "kraken" || instrument.marketType !== "spot") throw new Error("Kraken Spot protocol requires a Kraken spot instrument");
    const requestedDepth = options.krakenSpotDepth ?? options.maxLevels ?? 100;
    if (!SPOT_DEPTHS.has(requestedDepth)) throw new Error("Kraken Spot depth must be 10, 25, 100, 500 or 1000");
    this.depth = requestedDepth as typeof this.depth;
    this.book = new KrakenSpotChecksumBook(this.depth, options.publishLevels ?? Math.min(100, this.depth));
  }

  reset() {
    this.book.clear();
    this.updateOrdinal = 0;
    this.exchangeTs = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "subscribe", params: { channel: "book", symbol: [this.instrument.venueSymbol], depth: this.depth, snapshot: true }, req_id: 1 }));
  }

  heartbeat(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "ping", req_id: 2 }));
  }

  parse(text: string) {
    return parseKrakenSpotJson(text);
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Kraken Spot local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("Kraken Spot public message is not an object");
    if (envelope.channel === "heartbeat") return { kind: "heartbeat" };
    if (envelope.method === "pong") return envelope.success === false ? this.fail(`Kraken Spot ping failed: ${String(envelope.error ?? "rejected")}`) : { kind: "heartbeat" };
    if (envelope.method === "subscribe") return this.ack(envelope);
    if (envelope.channel !== "book") return { kind: "ignored" };
    const type = envelope.type;
    const rows = envelope.data;
    if ((type !== "snapshot" && type !== "update") || !Array.isArray(rows) || rows.length !== 1) return this.fail("Malformed Kraken Spot book envelope");
    const row = record(rows[0]);
    if (!row || row.symbol !== this.instrument.venueSymbol) return this.fail("Kraken Spot book symbol changed inside one subscription");
    const bids = spotLevels(row.bids);
    const asks = spotLevels(row.asks);
    const checksum = unsignedChecksum(row.checksum);
    const exchangeTs = isoTimestamp(row.timestamp);
    if (!bids || !asks || checksum === undefined || exchangeTs === undefined) return this.fail("Malformed Kraken Spot book payload");
    if (this.exchangeTs !== undefined && exchangeTs < this.exchangeTs) return this.fail(`Kraken Spot timestamp regressed from ${this.exchangeTs} to ${exchangeTs}`);
    if (type === "snapshot" && this.updateOrdinal !== 0) return this.fail("Kraken Spot received an unexpected replacement snapshot");
    if (type === "update" && this.updateOrdinal === 0) return this.fail("Kraken Spot update arrived before a checksum-verified snapshot");
    try {
      const levels = type === "snapshot" ? this.book.reset(bids, asks) : this.book.apply(bids, asks);
      if (levels.checksum !== checksum) return this.fail(`Kraken Spot checksum mismatch: calculated ${levels.checksum}, received ${checksum}`);
      this.updateOrdinal += 1;
      this.exchangeTs = exchangeTs;
      return {
        kind: "book",
        book: {
          venue: "kraken",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: "spot",
          quantityUnit: this.instrument.quantityUnit,
          bids: levels.bids,
          asks: levels.asks,
          exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "checksum-verified", sequence: this.updateOrdinal, checksum, protocol: "kraken-spot-crc32" },
          source: "public-websocket",
          retainedDepth: this.depth
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid Kraken Spot reconstructed book");
    }
  }

  private ack(envelope: Record<string, unknown>): ProtocolResult {
    if (envelope.success !== true) return this.fail(`Kraken Spot subscription rejected: ${String(envelope.error ?? "unknown error")}`);
    const result = record(envelope.result);
    if (!result || result.channel !== "book" || result.symbol !== this.instrument.venueSymbol || result.depth !== this.depth || result.snapshot !== true) {
      return this.fail("Kraken Spot subscription acknowledgement changed scope");
    }
    return { kind: "accepted" };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

/**
 * Kraken Futures v1 book. The native `seq` is required to advance, but is deliberately not called
 * gap-free because Kraken does not document per-product contiguity.
 */
export class KrakenFuturesContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://futures.kraken.com/ws/v1";
  readonly needsBootstrap = false;
  private readonly book: ContinuousBoundedBook;
  private sequence?: number;
  private exchangeTs?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "kraken" || instrument.marketType === "spot") throw new Error("Kraken Futures protocol requires a Kraken perpetual or future instrument");
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 1_000, options.publishLevels ?? 100);
  }

  reset() {
    this.book.clear();
    this.sequence = undefined;
    this.exchangeTs = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify({ event: "subscribe", feed: "book", product_ids: [this.instrument.venueSymbol] }));
    socket.send(JSON.stringify({ event: "subscribe", feed: "heartbeat" }));
  }

  heartbeat(socket: WebSocket) {
    socket.ping();
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Kraken Futures local receive timestamp is invalid");
    const row = record(value);
    if (!row) return this.fail("Kraken Futures public message is not an object");
    if (row.event === "error" || row.event === "subscribed_failed") return this.fail(`Kraken Futures subscription error: ${String(row.message ?? "rejected")}`);
    if (row.event === "subscribed") return this.ack(row);
    if (row.feed === "heartbeat") return safeInteger(row.time, 1) === undefined ? this.fail("Malformed Kraken Futures heartbeat") : { kind: "heartbeat" };
    if (row.feed === "book_snapshot") return this.snapshot(row, receivedAt);
    if (row.feed === "book") return this.update(row, receivedAt);
    return { kind: "ignored" };
  }

  private ack(row: Record<string, unknown>): ProtocolResult {
    if (row.feed === "heartbeat") return { kind: "accepted" };
    if (row.feed !== "book" || !Array.isArray(row.product_ids) || row.product_ids.length !== 1 || row.product_ids[0] !== this.instrument.venueSymbol) {
      return this.fail("Kraken Futures subscription acknowledgement changed scope");
    }
    return { kind: "accepted" };
  }

  private snapshot(row: Record<string, unknown>, receivedAt: number): ProtocolResult {
    if (this.sequence !== undefined) return this.fail("Kraken Futures received an unexpected replacement snapshot");
    const common = this.common(row);
    const bids = futuresLevels(row.bids, false);
    const asks = futuresLevels(row.asks, false);
    if (!common || !bids || !asks) return this.fail("Malformed Kraken Futures book snapshot");
    try {
      const levels = this.book.reset(bids, asks);
      this.sequence = common.sequence;
      this.exchangeTs = common.exchangeTs;
      return this.bookResult(levels, common, receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid Kraken Futures snapshot");
    }
  }

  private update(row: Record<string, unknown>, receivedAt: number): ProtocolResult {
    if (this.sequence === undefined || this.exchangeTs === undefined) return this.fail("Kraken Futures delta arrived before a full snapshot");
    const common = this.common(row);
    const price = finite(row.price);
    const quantity = finite(row.qty);
    const side = row.side;
    if (!common || price === undefined || price <= 0 || quantity === undefined || quantity < 0 || (side !== "buy" && side !== "sell")) return this.fail("Malformed Kraken Futures book delta");
    if (common.sequence <= this.sequence) return this.fail(`Kraken Futures seq did not advance beyond ${this.sequence}`);
    if (common.exchangeTs < this.exchangeTs) return this.fail(`Kraken Futures timestamp regressed from ${this.exchangeTs} to ${common.exchangeTs}`);
    try {
      const levels = this.book.apply(side === "buy" ? [[price, quantity]] : [], side === "sell" ? [[price, quantity]] : []);
      this.sequence = common.sequence;
      this.exchangeTs = common.exchangeTs;
      return this.bookResult(levels, common, receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid Kraken Futures delta");
    }
  }

  private common(row: Record<string, unknown>) {
    if (row.product_id !== this.instrument.venueSymbol) return undefined;
    const sequence = safeInteger(row.seq, 1);
    const exchangeTs = safeInteger(row.timestamp, 1);
    return sequence === undefined || exchangeTs === undefined ? undefined : { sequence, exchangeTs };
  }

  private bookResult(levels: ReturnType<ContinuousBoundedBook["snapshot"]>, common: { sequence: number; exchangeTs: number }, receivedAt: number): ProtocolResult {
    return {
      kind: "book",
      book: {
        venue: "kraken",
        instrumentId: this.instrument.instrumentId,
        venueSymbol: this.instrument.venueSymbol,
        marketType: this.instrument.marketType,
        quantityUnit: this.instrument.quantityUnit,
        bids: levels.bids,
        asks: levels.asks,
        exchangeTs: common.exchangeTs,
        receivedAt,
        complete: true,
        continuity: { kind: "sequence-observed", sequence: common.sequence, protocol: "kraken-futures-seq", sequenceVerified: false },
        source: "public-websocket",
        retainedDepth: this.book.retainedDepth()
      }
    };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

function spotLevels(value: unknown): KrakenSpotLevelInput[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LEVELS_PER_MESSAGE) return undefined;
  const levels: KrakenSpotLevelInput[] = [];
  for (const raw of value) {
    const row = record(raw);
    if (!row || row.price === undefined || row.qty === undefined) return undefined;
    levels.push({ price: row.price, qty: row.qty });
  }
  return levels;
}

function futuresLevels(value: unknown, allowZero: boolean): Array<[number, number]> | undefined {
  if (!Array.isArray(value) || value.length > MAX_LEVELS_PER_MESSAGE) return undefined;
  const levels: Array<[number, number]> = [];
  for (const raw of value) {
    const row = record(raw);
    const price = finite(row?.price);
    const quantity = finite(row?.qty);
    if (price === undefined || price <= 0 || quantity === undefined || quantity < 0 || (!allowZero && quantity === 0)) return undefined;
    levels.push([price, quantity]);
  }
  return levels;
}

function unsignedChecksum(value: unknown) {
  const parsed = safeInteger(value);
  return parsed !== undefined && parsed <= 0xffffffff ? parsed : undefined;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 80) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
