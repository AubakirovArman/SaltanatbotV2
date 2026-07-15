import type WebSocket from "ws";
import type { MutableL2Level } from "../l2/types.js";
import { ContinuousBoundedBook, finite, record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import { subscriptionError } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const MAX_LEVELS_PER_MESSAGE = 1_000;

export class HyperliquidContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://api.hyperliquid.xyz/ws";
  readonly needsBootstrap = false;
  private readonly book: ContinuousBoundedBook;
  private lastExchangeTs?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "hyperliquid") throw new Error("Hyperliquid protocol requires a Hyperliquid instrument");
    if (instrument.marketType === "future") throw new Error("Hyperliquid continuous feed supports spot and perpetual only");
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 100, options.publishLevels ?? 20);
  }

  reset() {
    this.book.clear();
    this.lastExchangeTs = undefined;
  }

  subscribe(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: this.instrument.venueSymbol } }));
    if (this.instrument.marketType === "perpetual") {
      socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: this.instrument.venueSymbol } }));
    }
  }

  heartbeat(socket: WebSocket) {
    socket.send(JSON.stringify({ method: "ping" }));
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("Hyperliquid local receive timestamp is invalid");
    const failure = subscriptionError(value);
    if (failure) return this.fail(`Hyperliquid ${failure}`);
    const envelope = record(value);
    if (!envelope) return this.fail("Hyperliquid public message is not an object");
    if (envelope.channel === "subscriptionResponse" || envelope.channel === "pong") return { kind: "accepted" };
    if (envelope.channel === "l2Book") return this.pushBook(envelope.data, receivedAt);
    if (envelope.channel === "activeAssetCtx") return this.pushFunding(envelope.data, receivedAt);
    return { kind: "ignored" };
  }

  private pushBook(value: unknown, receivedAt: number): ProtocolResult {
    const row = record(value);
    const exchangeTs = safeInteger(row?.time, 1);
    if (!row || row.coin !== this.instrument.venueSymbol || exchangeTs === undefined || !Array.isArray(row.levels) || row.levels.length !== 2) {
      return this.fail("Malformed Hyperliquid l2Book snapshot");
    }
    if (this.lastExchangeTs !== undefined && exchangeTs <= this.lastExchangeTs) return { kind: "ignored" };
    const bids = hyperliquidLevels(row.levels[0]);
    const asks = hyperliquidLevels(row.levels[1]);
    if (!bids || !asks) return this.fail("Malformed Hyperliquid l2Book levels");
    try {
      const levels = this.book.reset(bids, asks);
      this.lastExchangeTs = exchangeTs;
      return {
        kind: "book",
        book: {
          venue: "hyperliquid",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: this.instrument.marketType,
          quantityUnit: this.instrument.quantityUnit,
          bids: levels.bids,
          asks: levels.asks,
          exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "atomic-snapshot", protocol: "hyperliquid-block-snapshot", sequenceVerified: false },
          source: "public-websocket",
          retainedDepth: this.book.retainedDepth()
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid Hyperliquid L2 snapshot");
    }
  }

  private pushFunding(value: unknown, receivedAt: number): ProtocolResult {
    if (this.instrument.marketType !== "perpetual") return this.fail("Hyperliquid funding arrived for a non-perpetual instrument");
    const row = record(value);
    const context = record(row?.ctx);
    const currentEstimateRate = finite(context?.funding);
    if (!row || row.coin !== this.instrument.venueSymbol || currentEstimateRate === undefined) return this.fail("Malformed Hyperliquid activeAssetCtx payload");
    return {
      kind: "funding",
      funding: {
        venue: "hyperliquid",
        instrumentId: this.instrument.instrumentId,
        currentEstimateRate,
        scheduleVerified: false,
        exchangeTimestampVerified: false,
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

function hyperliquidLevels(value: unknown): MutableL2Level[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LEVELS_PER_MESSAGE) return undefined;
  const levels: MutableL2Level[] = [];
  for (const item of value) {
    const row = record(item);
    const price = finite(row?.px);
    const quantity = finite(row?.sz);
    if (price === undefined || price <= 0 || quantity === undefined || quantity <= 0) return undefined;
    levels.push([price, quantity]);
  }
  return levels;
}
