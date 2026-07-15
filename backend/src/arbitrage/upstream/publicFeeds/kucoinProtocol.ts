import type WebSocket from "ws";
import { KucoinObuBookReconciler, kucoinObuSubscription } from "../../../venues/kucoin/index.js";
import type { KucoinMarketType, KucoinObuMessage } from "../../../venues/kucoin/types.js";
import { record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const SPOT_URL = "wss://x-push-spot.kucoin.com";
const FUTURES_URL = "wss://x-push-futures.kucoin.com";
const SUBSCRIPTION_ID = "saltanat-public-book";
const PING_ID = "saltanat-public-ping";
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_KUCOIN_LEVELS = 500;
const MAX_PUBLISH_INTERVAL_MS = 1_000;

/**
 * Credential-free KuCoin post-2026-07-15 Increment Best 500 consumer.
 *
 * The public Pro socket becomes usable only after its `welcome` envelope, so `subscribe` stores
 * the generation-local socket and the protocol sends exactly one OBU subscription after that
 * envelope. Every reconnect resets the self-seeded snapshot and sequence proof.
 */
export class KucoinContinuousProtocol implements ContinuousVenueProtocol {
  readonly url: string;
  readonly needsBootstrap = false;
  private readonly book: KucoinObuBookReconciler;
  private readonly marketType: KucoinMarketType;
  private readonly publishLevels: number;
  private readonly retainedDepth: number;
  private readonly publishIntervalMs: number;
  private socket?: WebSocket;
  private welcomed = false;
  private subscribed = false;
  private pendingPing = false;
  private sequence?: string;
  private lastPublishedAt?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "kucoin" || (instrument.marketType !== "spot" && instrument.marketType !== "perpetual")) {
      throw new Error("KuCoin continuous protocol requires a KuCoin spot or perpetual instrument");
    }
    if ((instrument.marketType === "spot" && instrument.quantityUnit !== "base") || (instrument.marketType === "perpetual" && instrument.quantityUnit !== "contract")) {
      throw new Error("KuCoin continuous protocol requires base-unit Spot or contract-unit perpetual metadata");
    }
    this.marketType = instrument.marketType;
    this.url = instrument.marketType === "spot" ? SPOT_URL : FUTURES_URL;
    this.retainedDepth = bounded(options.maxLevels ?? MAX_KUCOIN_LEVELS, 1, MAX_KUCOIN_LEVELS, "KuCoin maxLevels");
    this.publishLevels = bounded(options.publishLevels ?? Math.min(100, this.retainedDepth), 1, this.retainedDepth, "KuCoin publishLevels");
    this.publishIntervalMs = bounded(options.publishIntervalMs ?? 0, 0, MAX_PUBLISH_INTERVAL_MS, "KuCoin publishIntervalMs");
    this.book = new KucoinObuBookReconciler(instrument.venueSymbol, this.marketType, {
      maxLevelsPerSide: this.retainedDepth,
      maxUpdatesPerMessage: 2_000
    });
  }

  reset() {
    this.book.reset();
    this.socket = undefined;
    this.welcomed = false;
    this.subscribed = false;
    this.pendingPing = false;
    this.sequence = undefined;
    this.lastPublishedAt = undefined;
  }

  subscribe(socket: WebSocket) {
    this.socket = socket;
  }

  heartbeat(socket: WebSocket) {
    if (!this.welcomed || socket !== this.socket) throw new Error("KuCoin public heartbeat attempted before the generation-local welcome");
    if (this.pendingPing) throw new Error("KuCoin public pong did not arrive before the next heartbeat");
    socket.send(JSON.stringify({ id: PING_ID, type: "ping" }));
    this.pendingPing = true;
  }

  parse(text: string) {
    return parseKucoinPublicJson(text);
  }

  decodeBinary(frame: Uint8Array) {
    if (!(frame instanceof Uint8Array) || frame.byteLength === 0 || frame.byteLength > MAX_MESSAGE_BYTES) {
      throw new Error(`KuCoin public binary JSON frame must contain between 1 and ${MAX_MESSAGE_BYTES} bytes`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      throw new Error("KuCoin public binary JSON frame is not valid UTF-8");
    }
    return parseKucoinPublicJson(text);
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("KuCoin local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("KuCoin public message is not an object");
    if (envelope.message === "welcome") return this.welcome(envelope);
    if (envelope.type === "pong") return this.pong(envelope);
    if (envelope.result !== undefined || envelope.id === SUBSCRIPTION_ID) return this.ack(envelope);
    if (envelope.code !== undefined || envelope.msg !== undefined || envelope.error !== undefined) {
      return this.fail(`KuCoin public subscription error: ${String(envelope.msg ?? envelope.error ?? envelope.code ?? "rejected")}`);
    }
    if (envelope.T !== "obu.SPOT" && envelope.T !== "obu.FUTURES") return { kind: "ignored" };
    if (!this.welcomed || !this.subscribed) return this.fail("KuCoin OBU data arrived before the public welcome and subscription");
    try {
      const advanced = this.book.advance(envelope as KucoinObuMessage);
      if (!advanced.changed) return { kind: "ignored" };
      const sequence = exactSafeSequence(advanced.sequence);
      if (!advanced.routeReady || sequence === undefined || advanced.exchangeTs === undefined) {
        return this.fail("KuCoin OBU snapshot did not establish a positive safe sequence proof");
      }
      this.sequence = advanced.sequence;
      if (!this.shouldPublish(receivedAt)) return { kind: "book-advanced" };
      const view = this.book.snapshot();
      this.lastPublishedAt = receivedAt;
      return {
        kind: "book",
        book: {
          venue: "kucoin",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: this.instrument.marketType,
          quantityUnit: this.instrument.quantityUnit,
          bids: view.bids.slice(0, this.publishLevels).map(([price, quantity]) => [price, quantity]),
          asks: view.asks.slice(0, this.publishLevels).map(([price, quantity]) => [price, quantity]),
          exchangeTs: advanced.exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "sequence-verified", sequence, protocol: "kucoin-obu-range" },
          source: "public-websocket",
          retainedDepth: this.retainedDepth
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid KuCoin OBU message");
    }
  }

  private shouldPublish(receivedAt: number) {
    return this.publishIntervalMs === 0 || this.lastPublishedAt === undefined || receivedAt < this.lastPublishedAt || receivedAt - this.lastPublishedAt >= this.publishIntervalMs;
  }

  private welcome(envelope: Record<string, unknown>): ProtocolResult {
    if (this.welcomed || this.subscribed) return this.fail("KuCoin public socket sent an unexpected replacement welcome");
    const sessionId = envelope.sessionId;
    const pingInterval = safeInteger(envelope.pingInterval, 1_000);
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 200 || pingInterval === undefined || pingInterval > 300_000) {
      return this.fail("Malformed KuCoin public welcome envelope");
    }
    const socket = this.socket;
    if (!socket) return this.fail("KuCoin public welcome has no generation-local socket");
    socket.send(JSON.stringify(kucoinObuSubscription(SUBSCRIPTION_ID, this.instrument.venueSymbol, this.marketType)));
    this.welcomed = true;
    this.subscribed = true;
    return { kind: "accepted" };
  }

  private ack(envelope: Record<string, unknown>): ProtocolResult {
    if (!this.subscribed || envelope.id !== SUBSCRIPTION_ID || (envelope.result !== true && envelope.result !== "true")) {
      return this.fail("KuCoin public OBU subscription acknowledgement changed scope or was rejected");
    }
    return { kind: "accepted" };
  }

  private pong(envelope: Record<string, unknown>): ProtocolResult {
    if (!this.welcomed || !this.pendingPing || envelope.id !== PING_ID || exactUnsignedInteger(envelope.ts) === undefined) {
      return this.fail("Malformed or unsolicited KuCoin public pong");
    }
    this.pendingPing = false;
    return { kind: "heartbeat" };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

/** Node 24 exposes the original numeric token to JSON revivers; keep O/C/M/P exact. */
export function parseKucoinPublicJson(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("KuCoin public message size is invalid");
  }
  type LosslessParse = (input: string, reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
  return (JSON.parse as LosslessParse)(text, (key, value, context) => {
    if ((key === "O" || key === "C" || key === "M" || key === "P" || key === "ts") && typeof value === "number" && context?.source) {
      return context.source;
    }
    return value;
  });
}

function exactSafeSequence(value: string | undefined) {
  if (!value || !/^\d{1,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && BigInt(parsed) === BigInt(value) ? parsed : undefined;
}

function exactUnsignedInteger(value: unknown) {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return /^\d{1,30}$/.test(text) ? text : undefined;
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
