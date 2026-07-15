import type WebSocket from "ws";
import type { MutableL2Level } from "../l2/types.js";
import { ContinuousBoundedBook, record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

// Coinbase's full BTC-USD snapshot currently exceeds 43k updates. The socket frame is capped
// separately and the reconstructed book still retains at most the configured 1,000 levels.
const MAX_LEVEL_UPDATES = 60_000;
const PUBLIC_USDC_EXCEPTIONS = new Set(["USDT-USDC", "EURC-USDC"]);

/** Credential-free Coinbase Advanced Trade `level2` consumer; `market_trades` is never subscribed. */
export class CoinbaseAdvancedContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://advanced-trade-ws.coinbase.com";
  readonly needsBootstrap = false;
  private readonly book: ContinuousBoundedBook;
  private connectionSequence?: number;
  private hasSnapshot = false;
  private updateEventTs?: number;
  private heartbeatCounter?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "coinbase" || instrument.marketType !== "spot") throw new Error("Coinbase Advanced protocol requires a Coinbase spot instrument");
    if (instrument.venueSymbol.endsWith("-USDC") && !PUBLIC_USDC_EXCEPTIONS.has(instrument.venueSymbol)) {
      throw new Error("Coinbase Advanced public channels alias most -USDC products to -USD; exact-identity continuous books are disabled");
    }
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 1_000, options.publishLevels ?? 100);
  }

  reset() {
    this.book.clear();
    this.connectionSequence = undefined;
    this.hasSnapshot = false;
    this.updateEventTs = undefined;
    this.heartbeatCounter = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify({ type: "subscribe", product_ids: [this.instrument.venueSymbol], channel: "level2" }));
    socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
  }

  heartbeat(socket: WebSocket) {
    socket.ping();
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Coinbase local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("Coinbase public message is not an object");
    if (envelope.type === "error") return this.fail(`Coinbase subscription error: ${String(envelope.message ?? "rejected")}`);
    const sequenceProblem = this.advanceConnectionSequence(envelope.sequence_num);
    if (sequenceProblem) return this.fail(sequenceProblem);
    if (envelope.channel === "subscriptions") return { kind: "accepted" };
    if (envelope.channel === "heartbeats") return this.heartbeatMessage(envelope);
    if (envelope.channel !== "l2_data") return { kind: "ignored" };
    return this.level2(envelope, receivedAt);
  }

  private advanceConnectionSequence(value: unknown): string | undefined {
    const sequence = safeInteger(value);
    if (sequence === undefined) return "Coinbase public envelope has no valid global sequence_num";
    if (this.connectionSequence === undefined) {
      if (sequence !== 0) return `Coinbase global sequence must start at 0, received ${sequence}`;
    } else {
      const expected = this.connectionSequence + 1;
      if (!Number.isSafeInteger(expected) || sequence !== expected) return `Coinbase global sequence gap: expected ${expected}, received ${sequence}`;
    }
    this.connectionSequence = sequence;
    return undefined;
  }

  private heartbeatMessage(envelope: Record<string, unknown>): ProtocolResult {
    const timestamp = isoTimestamp(envelope.timestamp);
    const events = envelope.events;
    if (timestamp === undefined || !Array.isArray(events) || events.length !== 1) return this.fail("Malformed Coinbase heartbeat envelope");
    const event = record(events[0]);
    const counter = safeInteger(event?.heartbeat_counter, 1);
    if (counter === undefined) return this.fail("Malformed Coinbase heartbeat counter");
    if (this.heartbeatCounter !== undefined && counter !== this.heartbeatCounter + 1) {
      return this.fail(`Coinbase heartbeat gap: expected ${this.heartbeatCounter + 1}, received ${counter}`);
    }
    this.heartbeatCounter = counter;
    return { kind: "heartbeat" };
  }

  private level2(envelope: Record<string, unknown>, receivedAt: number): ProtocolResult {
    const sequence = this.connectionSequence;
    const envelopeTs = isoTimestamp(envelope.timestamp);
    const events = envelope.events;
    if (sequence === undefined || envelopeTs === undefined || !Array.isArray(events) || events.length !== 1) return this.fail("Malformed Coinbase level2 envelope");
    const event = record(events[0]);
    const type = event?.type;
    if (!event || event.product_id !== this.instrument.venueSymbol || (type !== "snapshot" && type !== "update")) return this.fail("Coinbase level2 event changed product identity or type");
    const parsed = levelUpdates(event.updates, type === "snapshot");
    if (!parsed) return this.fail("Malformed or oversized Coinbase level2 updates");
    if (type === "snapshot" && this.hasSnapshot) return this.fail("Coinbase received an unexpected replacement snapshot");
    if (type === "update" && !this.hasSnapshot) return this.fail("Coinbase level2 update arrived before a snapshot");
    const exchangeTs = type === "snapshot" ? envelopeTs : parsed.exchangeTs;
    if (exchangeTs === undefined) return this.fail("Coinbase update has no valid matching-engine event time");
    // Coinbase documents epoch-sentinel event_time values in snapshots. Do not compare the
    // snapshot envelope timestamp with matching-engine event times from later deltas: production
    // deltas can legitimately precede the envelope timestamp while still being globally sequenced.
    if (type === "update" && this.updateEventTs !== undefined && exchangeTs < this.updateEventTs) {
      return this.fail(`Coinbase matching-engine event time regressed from ${this.updateEventTs} to ${exchangeTs}`);
    }
    try {
      const levels = type === "snapshot" ? this.book.reset(parsed.bids, parsed.asks) : this.book.apply(parsed.bids, parsed.asks);
      this.hasSnapshot = true;
      if (type === "update") this.updateEventTs = exchangeTs;
      return {
        kind: "book",
        book: {
          venue: "coinbase",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: "spot",
          quantityUnit: this.instrument.quantityUnit,
          bids: levels.bids,
          asks: levels.asks,
          exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "sequence-verified", sequence, protocol: "coinbase-advanced-sequence" },
          source: "public-websocket",
          retainedDepth: this.book.retainedDepth()
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid Coinbase reconstructed book");
    }
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

function levelUpdates(value: unknown, snapshot: boolean): { bids: MutableL2Level[]; asks: MutableL2Level[]; exchangeTs?: number } | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LEVEL_UPDATES) return undefined;
  const bids: MutableL2Level[] = [];
  const asks: MutableL2Level[] = [];
  let exchangeTs: number | undefined;
  for (const raw of value) {
    const row = record(raw);
    const price = decimal(row?.price_level, false);
    const quantity = decimal(row?.new_quantity, true);
    const side = row?.side;
    if (price === undefined || quantity === undefined || (side !== "bid" && side !== "offer")) return undefined;
    if (snapshot && quantity === 0) return undefined;
    if (!snapshot) {
      const eventTs = isoTimestamp(row?.event_time);
      if (eventTs === undefined) return undefined;
      exchangeTs = Math.max(exchangeTs ?? eventTs, eventTs);
    }
    (side === "bid" ? bids : asks).push([price, quantity]);
  }
  return { bids, asks, ...(exchangeTs === undefined ? {} : { exchangeTs }) };
}

function decimal(value: unknown, allowZero: boolean) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : undefined;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 80) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
