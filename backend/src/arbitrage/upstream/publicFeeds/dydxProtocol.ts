import type WebSocket from "ws";
import { DydxIndexerBookReconciler, decodeDydxIndexerBookMessage } from "../../../venues/dydx/index.js";
import { record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const DYDX_INDEXER_WS_URL = "wss://indexer.dydx.trade/v4/ws";
const DEFAULT_RETAINED_LEVELS = 400;
const MAX_RETAINED_LEVELS = 5_000;

/**
 * dYdX Indexer `v4_orderbook` wrapper.
 *
 * Unbatched message IDs are checked for exact continuity by the venue reducer, but an Indexer
 * book is not the current block proposer's canonical mempool. Consequently the emitted proof is
 * deliberately `sequence-observed` and can never enter route-ready economics.
 */
export class DydxIndexerContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = DYDX_INDEXER_WS_URL;
  readonly needsBootstrap = false;
  private readonly reconciler: DydxIndexerBookReconciler;
  private readonly publishLevels: number;
  private readonly retainedLevels: number;
  private connectedId?: string;
  private snapshotAccepted = false;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "dydx" || instrument.marketType !== "perpetual") {
      throw new Error("dYdX Indexer protocol requires a dYdX perpetual instrument");
    }
    this.retainedLevels = bounded(options.maxLevels ?? DEFAULT_RETAINED_LEVELS, 1, MAX_RETAINED_LEVELS, "dYdX maxLevels");
    this.publishLevels = bounded(options.publishLevels ?? Math.min(100, this.retainedLevels), 1, this.retainedLevels, "dYdX publishLevels");
    this.reconciler = new DydxIndexerBookReconciler(instrument.venueSymbol, {
      maxLevelsPerSide: this.retainedLevels,
      maxUpdatesPerMessage: bounded(options.maxBufferedLevelUpdates ?? 2_000, 1, 10_000, "dYdX maxUpdatesPerMessage")
    });
  }

  reset() {
    this.connectedId = undefined;
    this.snapshotAccepted = false;
    this.reconciler.reset();
  }

  subscribe(socket: WebSocket) {
    socket.send(
      JSON.stringify({
        type: "subscribe",
        channel: "v4_orderbook",
        id: this.instrument.venueSymbol,
        batched: false
      })
    );
  }

  heartbeat(socket: WebSocket) {
    // The Indexer sends RFC 6455 ping control frames and `ws` answers them automatically. An
    // outbound control ping also detects a half-open transport without inventing an application
    // message that the documented API does not support.
    socket.ping();
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("dYdX local receive timestamp is invalid");
    const envelope = record(value);
    if (!envelope) return this.fail("dYdX Indexer message is not an object");
    if (envelope.type === "connected") return this.acceptConnection(envelope);
    if (envelope.type === "unsubscribed" || envelope.type === "error") {
      return this.fail(`dYdX Indexer subscription failed: ${boundedMessage(envelope.message ?? envelope.error ?? envelope.type)}`);
    }
    if (envelope.channel !== "v4_orderbook") return { kind: "ignored" };
    if (!this.connectedId) return this.fail("dYdX order-book data arrived before the connected envelope");

    try {
      const message = decodeDydxIndexerBookMessage(value);
      if (message.connectionId !== this.connectedId) return this.fail("dYdX order-book connection identity changed");
      if (message.type === "subscribed" && this.snapshotAccepted) return this.fail("dYdX emitted an unexpected replacement snapshot");
      const view = this.reconciler.apply(message);
      if (view.status !== "ready" || !view.sequenceVerified || view.lastMessageId === undefined || view.lastMessageId <= 0) {
        return this.fail("dYdX order-book snapshot lacks a positive contiguous message ID");
      }
      if (!view.uncrossed || !view.bids[0] || !view.asks[0]) return this.fail("dYdX logical uncrossing produced an unusable book");
      this.snapshotAccepted = true;
      return {
        kind: "book",
        book: {
          venue: "dydx",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: "perpetual",
          quantityUnit: this.instrument.quantityUnit,
          bids: view.bids.slice(0, this.publishLevels).map(([price, quantity]) => [price, quantity]),
          asks: view.asks.slice(0, this.publishLevels).map(([price, quantity]) => [price, quantity]),
          // The official Indexer book envelope has no exchange timestamp. Local receipt is used
          // only to age this non-route-ready research observation.
          exchangeTs: receivedAt,
          receivedAt,
          complete: true,
          continuity: {
            kind: "sequence-observed",
            sequence: view.lastMessageId,
            protocol: "dydx-indexer-message-id",
            sequenceVerified: false
          },
          source: "public-websocket",
          retainedDepth: this.retainedLevels
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid dYdX Indexer order-book message");
    }
  }

  private acceptConnection(envelope: Record<string, unknown>): ProtocolResult {
    const connectionId = typeof envelope.connection_id === "string" ? envelope.connection_id.trim() : "";
    const messageId = safeInteger(envelope.message_id, 0);
    if (!connectionId || connectionId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(connectionId) || messageId !== 0) {
      return this.fail("Malformed dYdX connected envelope");
    }
    if (this.connectedId) return this.fail("dYdX emitted a duplicate connected envelope");
    this.connectedId = connectionId;
    return { kind: "accepted" };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason: boundedMessage(reason) };
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function boundedMessage(value: unknown) {
  return String(value ?? "unknown error").slice(0, 300);
}
