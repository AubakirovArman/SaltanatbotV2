import type WebSocket from "ws";
import {
  ExplicitMexcSpotProtobufDepthDecoder,
  MEXC_SPOT_PUBLIC_WS_URL,
  MexcFuturesBookReconciler,
  MexcSpotProtobufBookReconciler,
  mexcFuturesDepthSubscription,
  mexcSpotDepthSubscription
} from "../../../venues/mexc/index.js";
import type { MexcFuturesDepthMessage, MexcSpotProtobufDepthEnvelope } from "../../../venues/mexc/types.js";
import type { PublicDepthSnapshot, PublicDepthLevel } from "../../../venues/publicTypes.js";
import { record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

export const MEXC_FUTURES_PUBLIC_WS_URL = "wss://contract.mexc.com/edge" as const;

const DEFAULT_RETAINED_LEVELS = 1_000;
const MAX_RETAINED_LEVELS = 5_000;
const DEFAULT_BUFFERED_EVENTS = 256;
const DEFAULT_BUFFERED_UPDATES = 20_000;
const MAX_BUFFERED_EVENTS = 5_000;
const MAX_BUFFERED_UPDATES = 100_000;
const MAX_UPDATES_PER_MESSAGE = 10_000;
const MAX_PUBLISH_INTERVAL_MS = 1_000;

/** MEXC Spot public PB depth plus governed REST snapshot bridging. */
export class MexcSpotContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = MEXC_SPOT_PUBLIC_WS_URL;
  readonly needsBootstrap = true;
  readonly bootstrapMode = "protocol-triggered" as const;
  private readonly reconciler: MexcSpotProtobufBookReconciler;
  private readonly decoder: NonNullable<ProtocolOptions["mexcSpotDecoder"]>;
  private readonly maxBinaryFrameBytes: number;
  private readonly retainedLevels: number;
  private readonly publishLevels: number;
  private lastFrameReceivedAt?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "mexc" || instrument.marketType !== "spot" || instrument.quantityUnit !== "base") {
      throw new Error("MEXC Spot continuous protocol requires a base-unit MEXC Spot instrument");
    }
    this.retainedLevels = bounded(options.maxLevels ?? DEFAULT_RETAINED_LEVELS, 1, MAX_RETAINED_LEVELS, "MEXC Spot maxLevels");
    this.publishLevels = bounded(options.publishLevels ?? Math.min(100, this.retainedLevels), 1, this.retainedLevels, "MEXC Spot publishLevels");
    const maxEvents = bounded(options.maxBufferedEvents ?? DEFAULT_BUFFERED_EVENTS, 1, MAX_BUFFERED_EVENTS, "MEXC Spot maxBufferedEvents");
    const maxUpdates = bounded(options.maxBufferedLevelUpdates ?? DEFAULT_BUFFERED_UPDATES, 1, MAX_BUFFERED_UPDATES, "MEXC Spot maxBufferedLevelUpdates");
    const maxPerMessage = Math.min(MAX_UPDATES_PER_MESSAGE, maxUpdates);
    this.maxBinaryFrameBytes = bounded(options.mexcSpotMaxFrameBytes ?? 512 * 1024, 256, 2 * 1024 * 1024, "MEXC Spot maxFrameBytes");
    this.decoder =
      options.mexcSpotDecoder ??
      new ExplicitMexcSpotProtobufDepthDecoder({ maxFrameBytes: this.maxBinaryFrameBytes, maxLevelUpdates: maxPerMessage });
    this.reconciler = new MexcSpotProtobufBookReconciler(instrument.venueSymbol, {
      maxLevelsPerSide: this.retainedLevels,
      maxUpdatesPerMessage: maxPerMessage,
      maxBufferedMessages: maxEvents,
      maxBufferedLevelUpdates: maxUpdates
    });
  }

  reset() {
    this.reconciler.reset();
    this.lastFrameReceivedAt = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify(mexcSpotDepthSubscription(this.instrument.venueSymbol)));
  }

  heartbeat(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "PING" }));
  }

  decodeBinary(frame: Uint8Array) {
    if (frame.byteLength > this.maxBinaryFrameBytes) throw new Error(`MEXC Spot binary frame exceeds ${this.maxBinaryFrameBytes} bytes`);
    return this.decoder.decode(frame);
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("MEXC Spot local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("MEXC Spot public message is not an object");
    if (envelope.code !== undefined || envelope.msg !== undefined || envelope.id !== undefined) return this.control(envelope);
    try {
      const view = this.reconciler.ingestDecoded(value as MexcSpotProtobufDepthEnvelope);
      this.lastFrameReceivedAt = receivedAt;
      if (!view.routeReady) return view.bufferedMessages === 1 ? { kind: "bootstrap-required" } : { kind: "accepted" };
      return this.book(view, receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid MEXC Spot Protobuf depth message");
    }
  }

  applyBootstrap(snapshot: PublicDepthSnapshot): ProtocolResult {
    const issue = bootstrapIssue(snapshot, this.instrument);
    if (issue) return this.fail(`MEXC Spot REST bootstrap ${issue}`);
    try {
      const view = this.reconciler.seed(
        { lastUpdateId: snapshot.sequence, bids: snapshot.bids, asks: snapshot.asks },
        snapshot.receivedAt
      );
      const sequence = exactSafeSequence(view.sequence);
      if (sequence === undefined || sequence <= snapshot.sequence) return { kind: "accepted" };
      return this.book(view, this.lastFrameReceivedAt ?? snapshot.receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid MEXC Spot REST bootstrap");
    }
  }

  private control(envelope: Record<string, unknown>): ProtocolResult {
    const code = safeInteger(envelope.code);
    const message = envelope.msg;
    if (code !== 0 || typeof message !== "string" || message.length < 1 || message.length > 200) {
      return this.fail(`MEXC Spot subscription rejected: ${boundedMessage(message ?? envelope.code ?? "unknown")}`);
    }
    if (message === "PONG") return { kind: "heartbeat" };
    const expected = mexcSpotDepthSubscription(this.instrument.venueSymbol).params[0];
    return message === expected ? { kind: "accepted" } : this.fail("MEXC Spot subscription acknowledgement changed scope");
  }

  private book(view: ReturnType<MexcSpotProtobufBookReconciler["snapshot"]>, receivedAt: number): ProtocolResult {
    const sequence = exactSafeSequence(view.sequence);
    if (!view.routeReady || sequence === undefined || view.exchangeTs === undefined || !view.bids[0] || !view.asks[0]) {
      return this.fail("MEXC Spot book lacks a positive version proof and both sides");
    }
    return {
      kind: "book",
      book: {
        venue: "mexc",
        instrumentId: this.instrument.instrumentId,
        venueSymbol: this.instrument.venueSymbol,
        marketType: "spot",
        quantityUnit: "base",
        bids: publish(view.bids, this.publishLevels),
        asks: publish(view.asks, this.publishLevels),
        exchangeTs: view.exchangeTs,
        receivedAt,
        complete: true,
        continuity: { kind: "sequence-verified", sequence, protocol: "mexc-spot-version" },
        source: "public-websocket",
        retainedDepth: this.retainedLevels
      }
    };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason: boundedMessage(reason) };
  }
}

interface BufferedFuturesEvent {
  value: MexcFuturesDepthMessage;
  receivedAt: number;
  updates: number;
}

/** MEXC Futures native JSON `push.depth`; every accepted live version is exactly previous + 1. */
export class MexcFuturesContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = MEXC_FUTURES_PUBLIC_WS_URL;
  readonly needsBootstrap = true;
  readonly bootstrapMode = "protocol-triggered" as const;
  private readonly reconciler: MexcFuturesBookReconciler;
  private readonly retainedLevels: number;
  private readonly publishLevels: number;
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedUpdates: number;
  private readonly maxUpdatesPerMessage: number;
  private readonly publishIntervalMs: number;
  private buffered: BufferedFuturesEvent[] = [];
  private bufferedUpdates = 0;
  private ready = false;
  private lastPublishedAt?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "mexc" || instrument.marketType !== "perpetual" || instrument.quantityUnit !== "contract") {
      throw new Error("MEXC Futures continuous protocol requires a contract-unit MEXC perpetual instrument");
    }
    this.retainedLevels = bounded(options.maxLevels ?? DEFAULT_RETAINED_LEVELS, 1, MAX_RETAINED_LEVELS, "MEXC Futures maxLevels");
    this.publishLevels = bounded(options.publishLevels ?? Math.min(100, this.retainedLevels), 1, this.retainedLevels, "MEXC Futures publishLevels");
    this.maxBufferedEvents = bounded(options.maxBufferedEvents ?? DEFAULT_BUFFERED_EVENTS, 1, MAX_BUFFERED_EVENTS, "MEXC Futures maxBufferedEvents");
    this.maxBufferedUpdates = bounded(options.maxBufferedLevelUpdates ?? DEFAULT_BUFFERED_UPDATES, 1, MAX_BUFFERED_UPDATES, "MEXC Futures maxBufferedLevelUpdates");
    this.maxUpdatesPerMessage = Math.min(MAX_UPDATES_PER_MESSAGE, this.maxBufferedUpdates);
    this.publishIntervalMs = bounded(options.publishIntervalMs ?? 0, 0, MAX_PUBLISH_INTERVAL_MS, "MEXC Futures publishIntervalMs");
    this.reconciler = new MexcFuturesBookReconciler(instrument.venueSymbol, {
      maxLevelsPerSide: this.retainedLevels,
      maxUpdatesPerMessage: this.maxUpdatesPerMessage
    });
  }

  reset() {
    this.reconciler.reset();
    this.buffered = [];
    this.bufferedUpdates = 0;
    this.ready = false;
    this.lastPublishedAt = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify(mexcFuturesDepthSubscription(this.instrument.venueSymbol)));
  }

  heartbeat(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "ping" }));
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("MEXC Futures local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("MEXC Futures public message is not an object");
    if (envelope.channel === "pong") return safeInteger(envelope.data, 1) === undefined ? this.fail("Malformed MEXC Futures pong") : { kind: "heartbeat" };
    if (envelope.channel === "rs.error") return this.fail(`MEXC Futures subscription rejected: ${boundedMessage(envelope.data ?? "unknown")}`);
    if (envelope.channel === "rs.sub.depth") return envelope.data === "success" ? { kind: "accepted" } : this.fail("MEXC Futures depth subscription was not accepted");
    if (envelope.channel !== "push.depth") return { kind: "ignored" };
    const updates = inspectFuturesEvent(envelope, this.instrument.venueSymbol, this.maxUpdatesPerMessage);
    if (typeof updates === "string") return this.fail(updates);
    if (!this.ready) {
      if (this.buffered.length >= this.maxBufferedEvents || this.bufferedUpdates + updates > this.maxBufferedUpdates) {
        return this.fail("MEXC Futures depth bootstrap buffer exceeded its hard bound");
      }
      this.buffered.push({ value: value as MexcFuturesDepthMessage, receivedAt, updates });
      this.bufferedUpdates += updates;
      return this.buffered.length === 1 ? { kind: "bootstrap-required" } : { kind: "accepted" };
    }
    return this.apply(value as MexcFuturesDepthMessage, receivedAt);
  }

  applyBootstrap(snapshot: PublicDepthSnapshot): ProtocolResult {
    const issue = bootstrapIssue(snapshot, this.instrument);
    if (issue) return this.fail(`MEXC Futures REST bootstrap ${issue}`);
    try {
      let view = this.reconciler.seed({ version: snapshot.sequence, timestamp: snapshot.exchangeTs, bids: snapshot.bids, asks: snapshot.asks });
      let receivedAt = snapshot.receivedAt;
      this.ready = true;
      const buffered = this.buffered;
      this.buffered = [];
      this.bufferedUpdates = 0;
      for (const event of buffered) {
        const before = view.sequence;
        view = this.reconciler.apply(event.value);
        if (view.sequence !== before) receivedAt = event.receivedAt;
      }
      const sequence = exactSafeSequence(view.sequence);
      if (sequence === undefined || sequence <= snapshot.sequence) return { kind: "accepted" };
      return this.book(view, receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid MEXC Futures REST bootstrap or buffered delta");
    }
  }

  private apply(value: MexcFuturesDepthMessage, receivedAt: number): ProtocolResult {
    try {
      const advanced = this.reconciler.advance(value);
      if (!advanced.changed) return { kind: "ignored" };
      if (!this.shouldPublish(receivedAt)) return { kind: "book-advanced" };
      return this.book(this.reconciler.snapshot(), receivedAt);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid MEXC Futures depth delta");
    }
  }

  private book(view: ReturnType<MexcFuturesBookReconciler["snapshot"]>, receivedAt: number): ProtocolResult {
    const sequence = exactSafeSequence(view.sequence);
    if (!view.routeReady || sequence === undefined || view.exchangeTs === undefined || !view.bids[0] || !view.asks[0]) {
      return this.fail("MEXC Futures book lacks a positive version proof and both sides");
    }
    this.lastPublishedAt = receivedAt;
    return {
      kind: "book",
      book: {
        venue: "mexc",
        instrumentId: this.instrument.instrumentId,
        venueSymbol: this.instrument.venueSymbol,
        marketType: "perpetual",
        quantityUnit: "contract",
        bids: publish(view.bids, this.publishLevels),
        asks: publish(view.asks, this.publishLevels),
        exchangeTs: view.exchangeTs,
        receivedAt,
        complete: true,
        continuity: { kind: "sequence-verified", sequence, protocol: "mexc-futures-version" },
        source: "public-websocket",
        retainedDepth: this.retainedLevels
      }
    };
  }

  private shouldPublish(receivedAt: number) {
    return this.publishIntervalMs === 0 || this.lastPublishedAt === undefined || receivedAt < this.lastPublishedAt || receivedAt - this.lastPublishedAt >= this.publishIntervalMs;
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason: boundedMessage(reason) };
  }
}

function inspectFuturesEvent(envelope: Record<string, unknown>, symbol: string, maximum: number): number | string {
  if (envelope.symbol !== symbol || safeInteger(envelope.ts, 1) === undefined) return "Malformed MEXC Futures depth identity or timestamp";
  const data = record(envelope.data);
  if (!data || exactSafeSequence(data.version) === undefined || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return "Malformed MEXC Futures depth payload";
  const updates = data.bids.length + data.asks.length;
  if (updates < 1 || updates > maximum) return `MEXC Futures depth payload must contain between 1 and ${maximum} updates`;
  return updates;
}

function bootstrapIssue(snapshot: PublicDepthSnapshot, instrument: ContinuousFeedInstrument): string | undefined {
  if (snapshot.venue !== "mexc" || snapshot.instrumentId !== instrument.venueSymbol || snapshot.marketType !== instrument.marketType || snapshot.quantityUnit !== instrument.quantityUnit) {
    return "identity does not match the subscription";
  }
  if (!snapshot.complete || exactSafeSequence(snapshot.sequence) === undefined || !validReceivedAt(snapshot.receivedAt) || !validReceivedAt(snapshot.exchangeTs)) {
    return "does not contain a complete positive-sequence book";
  }
  return undefined;
}

function exactSafeSequence(value: unknown) {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9][0-9]*$/.test(String(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function publish(levels: readonly PublicDepthLevel[], limit: number): Array<[number, number]> {
  return levels.slice(0, limit).map(([price, quantity]) => [price, quantity]);
}

function boundedMessage(value: unknown) {
  return String(value).replaceAll(/\s+/g, " ").trim().slice(0, 300) || "MEXC public feed failed";
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
