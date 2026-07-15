import type WebSocket from "ws";
import type { MutableL2Level } from "../l2/types.js";
import { ContinuousBoundedBook, finite, record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import { subscriptionError } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const MAX_LEVELS_PER_MESSAGE = 5_000;

export class DeribitContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://www.deribit.com/ws/api/v2";
  readonly needsBootstrap = false;
  private readonly book: ContinuousBoundedBook;
  private sequence?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "deribit") throw new Error("Deribit protocol requires a Deribit instrument");
    if (instrument.marketType === "spot") throw new Error("Deribit continuous feed does not support spot");
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 1_000, options.publishLevels ?? 100);
  }

  reset() {
    this.book.clear();
    this.sequence = undefined;
  }

  subscribe(socket: WebSocket) {
    const channels = [`book.${this.instrument.venueSymbol}.100ms`];
    if (this.instrument.marketType === "perpetual") channels.push(`ticker.${this.instrument.venueSymbol}.100ms`);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "public/subscribe", params: { channels } }));
  }

  heartbeat(socket: WebSocket) {
    socket.ping();
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Deribit local receive timestamp is invalid");
    const failure = subscriptionError(value);
    if (failure) return this.fail(`Deribit ${failure}`);
    const envelope = record(value);
    if (!envelope) return this.fail("Deribit public message is not an object");
    if (envelope.id === 1 && Array.isArray(envelope.result)) return { kind: "accepted" };
    if (envelope.method !== "subscription") return { kind: "ignored" };
    const params = record(envelope.params);
    const channel = typeof params?.channel === "string" ? params.channel : "";
    if (channel === `book.${this.instrument.venueSymbol}.100ms`) return this.pushBook(params?.data, receivedAt);
    if (channel === `ticker.${this.instrument.venueSymbol}.100ms`) return this.pushFunding(params?.data, receivedAt);
    return { kind: "ignored" };
  }

  private pushBook(value: unknown, receivedAt: number): ProtocolResult {
    const row = record(value);
    const type = row?.type;
    const sequence = safeInteger(row?.change_id, 1);
    const exchangeTs = safeInteger(row?.timestamp, 1);
    if (!row || row.instrument_name !== this.instrument.venueSymbol || (type !== "snapshot" && type !== "change") || sequence === undefined || exchangeTs === undefined) {
      return this.fail("Malformed Deribit book notification");
    }
    const bids = deribitChanges(row.bids, type === "snapshot");
    const asks = deribitChanges(row.asks, type === "snapshot");
    if (!bids || !asks) return this.fail("Malformed Deribit book levels");
    try {
      let levels: ReturnType<ContinuousBoundedBook["snapshot"]>;
      if (type === "snapshot") {
        if (row.prev_change_id !== undefined) return this.fail("Deribit initial snapshot unexpectedly contains prev_change_id");
        levels = this.book.reset(bids, asks);
      } else {
        const previous = safeInteger(row.prev_change_id, 1);
        if (this.sequence === undefined) return this.fail("Deribit change arrived before a full snapshot");
        if (previous !== this.sequence) return this.fail(`Deribit sequence gap: expected prev_change_id ${this.sequence}, received ${String(row.prev_change_id)}`);
        if (sequence <= this.sequence) return this.fail(`Deribit change_id did not advance beyond ${this.sequence}`);
        levels = this.book.apply(bids, asks);
      }
      this.sequence = sequence;
      return {
        kind: "book",
        book: {
          venue: "deribit",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: this.instrument.marketType,
          quantityUnit: this.instrument.quantityUnit,
          bids: levels.bids,
          asks: levels.asks,
          exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "sequence-verified", sequence, protocol: "deribit-change-id" },
          source: "public-websocket",
          retainedDepth: this.book.retainedDepth()
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Deribit reconstructed book is invalid");
    }
  }

  private pushFunding(value: unknown, receivedAt: number): ProtocolResult {
    if (this.instrument.marketType !== "perpetual") return this.fail("Deribit funding arrived for a dated future");
    const row = record(value);
    const currentEstimateRate = finite(row?.funding_8h);
    const exchangeTs = safeInteger(row?.timestamp, 1);
    if (!row || row.instrument_name !== this.instrument.venueSymbol || currentEstimateRate === undefined || exchangeTs === undefined) {
      return this.fail("Malformed Deribit funding ticker");
    }
    return {
      kind: "funding",
      funding: {
        venue: "deribit",
        instrumentId: this.instrument.instrumentId,
        currentEstimateRate,
        scheduleVerified: false,
        exchangeTs,
        exchangeTimestampVerified: true,
        receivedAt,
        source: "public-websocket"
      }
    };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

function deribitChanges(value: unknown, snapshot: boolean): MutableL2Level[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LEVELS_PER_MESSAGE) return undefined;
  const levels: MutableL2Level[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 3) return undefined;
    const action = raw[0];
    const price = finite(raw[1]);
    const amount = finite(raw[2]);
    if ((action !== "new" && action !== "change" && action !== "delete") || price === undefined || price <= 0 || amount === undefined || amount < 0) return undefined;
    if (snapshot && (action === "delete" || amount === 0)) return undefined;
    if (action === "delete" && amount !== 0) return undefined;
    levels.push([price, action === "delete" ? 0 : amount]);
  }
  return levels;
}
