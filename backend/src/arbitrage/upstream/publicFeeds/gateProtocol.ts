import type WebSocket from "ws";
import type { PublicDepthSnapshot } from "../../../venues/publicTypes.js";
import { parseL2Levels } from "../l2/boundedBook.js";
import type { MutableL2Level } from "../l2/types.js";
import { ContinuousBoundedBook, finite, record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import { subscriptionError } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const MAX_LEVELS_PER_MESSAGE = 2_000;

interface GateDepthEvent {
  first: number;
  last: number;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  exchangeTs: number;
  receivedAt: number;
  full: boolean;
}

export class GateContinuousProtocol implements ContinuousVenueProtocol {
  readonly url: string;
  readonly needsBootstrap: boolean;
  private readonly book: ContinuousBoundedBook;
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedLevelUpdates: number;
  private readonly mode: NonNullable<ProtocolOptions["gateMode"]>;
  private buffered: GateDepthEvent[] = [];
  private bufferedLevelUpdates = 0;
  private sequence?: number;
  private ready = false;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "gate") throw new Error("Gate protocol requires a Gate instrument");
    if (instrument.marketType === "future") throw new Error("Gate continuous feed supports spot and USDT perpetual only");
    this.url = instrument.marketType === "spot" ? "wss://api.gateio.ws/ws/v4/" : "wss://fx-ws.gateio.ws/v4/ws/usdt";
    this.mode = options.gateMode ?? "obu";
    this.needsBootstrap = this.mode === "incremental-rest-bridge";
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 400, options.publishLevels ?? 100);
    this.maxBufferedEvents = bounded(options.maxBufferedEvents ?? 1_024, "maxBufferedEvents");
    this.maxBufferedLevelUpdates = bounded(options.maxBufferedLevelUpdates ?? 100_000, "maxBufferedLevelUpdates");
  }

  reset() {
    this.book.clear();
    this.buffered = [];
    this.bufferedLevelUpdates = 0;
    this.sequence = undefined;
    this.ready = false;
  }

  subscribe(socket: WebSocket, now: number) {
    const time = Math.floor(now / 1_000);
    if (this.instrument.marketType === "spot") {
      socket.send(JSON.stringify({ time, channel: "spot.obu", event: "subscribe", payload: [`ob.${this.instrument.venueSymbol}.50`] }));
      return;
    }
    if (this.mode === "incremental-rest-bridge") {
      socket.send(JSON.stringify({ time, channel: "futures.order_book_update", event: "subscribe", payload: [this.instrument.venueSymbol, "100ms", "100"] }));
    } else {
      socket.send(JSON.stringify({ time, channel: "futures.obu", event: "subscribe", payload: [`ob.${this.instrument.venueSymbol}.50`] }));
    }
    socket.send(JSON.stringify({ time, channel: "futures.tickers", event: "subscribe", payload: [this.instrument.venueSymbol] }));
  }

  heartbeat(socket: WebSocket) {
    socket.ping();
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Gate local receive timestamp is invalid");
    const failure = subscriptionError(value);
    if (failure) return this.fail(`Gate ${failure}`);
    const envelope = record(value);
    if (!envelope) return this.fail("Gate public message is not an object");
    if ((envelope.event === "subscribe" || envelope.event === "unsubscribe") && record(envelope.result)?.status === "success") return { kind: "accepted" };
    if (envelope.channel === "spot.obu" || envelope.channel === "futures.obu" || envelope.channel === "futures.order_book_update") {
      const event = this.parseDepth(envelope, receivedAt);
      return event ? this.pushDepth(event) : this.fail("Malformed Gate order-book update");
    }
    if (envelope.channel === "futures.tickers") return this.pushFunding(envelope, receivedAt);
    return { kind: "ignored" };
  }

  applyBootstrap(snapshot: PublicDepthSnapshot): ProtocolResult {
    if (!this.needsBootstrap || this.ready) return { kind: "ignored" };
    if (snapshot.venue !== "gate" || snapshot.instrumentId !== this.instrument.venueSymbol || snapshot.marketType !== this.instrument.marketType) {
      return this.fail("Gate REST bootstrap identity does not match the subscription");
    }
    try {
      this.book.reset(
        snapshot.bids.map(([price, quantity]) => [price, quantity]),
        snapshot.asks.map(([price, quantity]) => [price, quantity])
      );
      this.sequence = snapshot.sequence;
      const retained = this.buffered;
      this.buffered = [];
      this.bufferedLevelUpdates = 0;
      let latest: ProtocolResult = { kind: "accepted" };
      for (const event of retained) {
        const result = this.applyDelta(event);
        if (result.kind === "gap") return result;
        if (result.kind === "book") latest = result;
      }
      return latest;
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Gate REST bootstrap is invalid");
    }
  }

  private parseDepth(envelope: Record<string, unknown>, receivedAt: number): GateDepthEvent | undefined {
    if (envelope.event !== "update") return undefined;
    const row = record(envelope.result);
    if (!row || !this.matchesSymbol(row.s)) return undefined;
    const last = safeInteger(row.u, 1);
    const first = safeInteger(row.U, 1) ?? (row.full === true ? last : undefined);
    const exchangeTs = safeInteger(row.t, 1) ?? safeInteger(envelope.time_ms, 1);
    const full = row.full === true;
    const arrayLevels = envelope.channel === "spot.obu" || envelope.channel === "futures.obu";
    const rawBids = row.b ?? (full ? undefined : []);
    const rawAsks = row.a ?? (full ? undefined : []);
    const bids = arrayLevels ? parseL2Levels(rawBids, MAX_LEVELS_PER_MESSAGE) : gateObjectLevels(rawBids);
    const asks = arrayLevels ? parseL2Levels(rawAsks, MAX_LEVELS_PER_MESSAGE) : gateObjectLevels(rawAsks);
    if (first === undefined || last === undefined || first > last || exchangeTs === undefined || !bids || !asks) return undefined;
    return { first, last, bids, asks, exchangeTs, receivedAt, full };
  }

  private pushDepth(event: GateDepthEvent): ProtocolResult {
    if (event.full) {
      try {
        const levels = this.book.reset(event.bids, event.asks);
        this.buffered = [];
        this.bufferedLevelUpdates = 0;
        this.sequence = event.last;
        this.ready = true;
        return this.output(event, levels);
      } catch (error) {
        return this.fail(error instanceof Error ? error.message : "Gate full snapshot is invalid");
      }
    }
    if (!this.ready) {
      const updates = event.bids.length + event.asks.length;
      if (this.buffered.length >= this.maxBufferedEvents || this.bufferedLevelUpdates + updates > this.maxBufferedLevelUpdates) {
        return this.fail("Gate depth bootstrap buffer exceeded its hard bound");
      }
      this.buffered.push(event);
      this.bufferedLevelUpdates += updates;
      return { kind: "accepted" };
    }
    return this.applyDelta(event);
  }

  private applyDelta(event: GateDepthEvent): ProtocolResult {
    const sequence = this.sequence;
    if (sequence === undefined) return this.fail("Gate live depth lost its sequence");
    if (event.last <= sequence) return { kind: "ignored" };
    const next = sequence + 1;
    if (event.first > next) return this.fail(`Gate sequence gap: expected update ${next}, received ${event.first}`);
    if (event.last < next) return { kind: "ignored" };
    try {
      const levels = this.book.apply(event.bids, event.asks);
      this.sequence = event.last;
      this.ready = true;
      return this.output(event, levels);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Gate reconstructed depth is invalid");
    }
  }

  private output(event: GateDepthEvent, levels: { bids: MutableL2Level[]; asks: MutableL2Level[] }): ProtocolResult {
    return {
      kind: "book",
      book: {
        venue: "gate",
        instrumentId: this.instrument.instrumentId,
        venueSymbol: this.instrument.venueSymbol,
        marketType: this.instrument.marketType,
        quantityUnit: this.instrument.quantityUnit,
        bids: levels.bids,
        asks: levels.asks,
        exchangeTs: event.exchangeTs,
        receivedAt: event.receivedAt,
        complete: true,
        continuity: { kind: "sequence-verified", sequence: this.sequence as number, protocol: "gate-update-id" },
        source: "public-websocket",
        retainedDepth: this.book.retainedDepth()
      }
    };
  }

  private pushFunding(envelope: Record<string, unknown>, receivedAt: number): ProtocolResult {
    if (this.instrument.marketType !== "perpetual" || envelope.event !== "update" || !Array.isArray(envelope.result)) return this.fail("Malformed Gate funding ticker envelope");
    const matching = envelope.result.map(record).filter((row): row is Record<string, unknown> => Boolean(row && row.contract === this.instrument.venueSymbol));
    if (matching.length !== 1) return this.fail("Gate funding ticker does not contain exactly one subscribed contract");
    const row = matching[0]!;
    const currentEstimateRate = finite(row.funding_rate);
    const exchangeTs = safeInteger(row.t, 1) ?? safeInteger(envelope.time_ms, 1);
    if (currentEstimateRate === undefined || exchangeTs === undefined) return this.fail("Malformed Gate funding ticker payload");
    return {
      kind: "funding",
      funding: {
        venue: "gate",
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

  private matchesSymbol(value: unknown) {
    return value === this.instrument.venueSymbol || value === `ob.${this.instrument.venueSymbol}.50`;
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

function gateObjectLevels(value: unknown): MutableL2Level[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LEVELS_PER_MESSAGE) return undefined;
  const levels: MutableL2Level[] = [];
  for (const item of value) {
    const row = record(item);
    const price = finite(row?.p);
    const quantity = finite(row?.s);
    if (price === undefined || price <= 0 || quantity === undefined || quantity < 0) return undefined;
    levels.push([price, quantity]);
  }
  return levels;
}

function bounded(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${label} is invalid`);
  return value;
}
