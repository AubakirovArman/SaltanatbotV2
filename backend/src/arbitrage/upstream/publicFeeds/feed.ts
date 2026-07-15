import WebSocket from "ws";
import type { RawData } from "ws";
import type { PublicVenueAdapter } from "../../../venues/publicTypes.js";
import { publicVenueAdapters } from "../../../venues/publicRegistry.js";
import { processPublicUpstreamGovernor, publicUpstreamSource } from "../resourceGovernor/process.js";
import { UpstreamCircuitOpenError, UpstreamSourceOverloadError, type UpstreamResourceGovernor } from "../resourceGovernor/index.js";
import type { UpstreamResourceLease } from "../resourceGovernor/types.js";
import { createContinuousVenueProtocol } from "./protocolFactory.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import { processPublicStreamGovernor, PUBLIC_STREAM_SOURCES } from "./process.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousFeedState, ContinuousFeedSubscription, ContinuousPublicBook } from "./types.js";

export interface ContinuousPublicFeedOptions extends ProtocolOptions {
  adapter?: PublicVenueAdapter;
  governor?: UpstreamResourceGovernor;
  restGovernor?: UpstreamResourceGovernor;
  createSocket?: (url: string, instrument: ContinuousFeedInstrument) => WebSocket;
  now?: () => number;
  random?: () => number;
  messageTimeoutMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_BOOK_PUBLISH_INTERVAL_MS = 100;

/** One isolated, bounded, credential-free public instrument lifecycle. */
export class ContinuousPublicFeed implements ContinuousFeedSubscription {
  private readonly protocol: ContinuousVenueProtocol;
  private readonly adapter?: PublicVenueAdapter;
  private readonly governor: UpstreamResourceGovernor;
  private readonly restGovernor: UpstreamResourceGovernor;
  private readonly createSocket: (url: string, instrument: ContinuousFeedInstrument) => WebSocket;
  private readonly now: () => number;
  private readonly messageTimeoutMs: number;
  private readonly heartbeatMs: number;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private bootstrapController?: AbortController;
  private admission?: UpstreamResourceLease;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private lastAcceptedAt = 0;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    private readonly callbacks: ContinuousFeedCallbacks,
    private readonly options: ContinuousPublicFeedOptions = {}
  ) {
    this.protocol = createContinuousVenueProtocol(instrument, {
      ...options,
      publishIntervalMs: options.publishIntervalMs ?? DEFAULT_BOOK_PUBLISH_INTERVAL_MS
    });
    this.adapter = options.adapter ?? publicVenueAdapters.get(instrument.venue);
    this.governor = options.governor ?? processPublicStreamGovernor;
    this.restGovernor = options.restGovernor ?? processPublicUpstreamGovernor;
    this.createSocket = options.createSocket ?? defaultSocket;
    this.now = options.now ?? Date.now;
    this.messageTimeoutMs = boundedDuration(options.messageTimeoutMs ?? 30_000, "messageTimeoutMs");
    this.heartbeatMs = boundedDuration(options.heartbeatMs ?? 15_000, "heartbeatMs");
    if (this.protocol.needsBootstrap && (!this.adapter || this.adapter.venue !== instrument.venue)) {
      throw new Error(`${instrument.venue} continuous feed requires its public REST adapter for sequence bridging`);
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.bootstrapController?.abort(new Error("Continuous public feed stopped"));
    this.bootstrapController = undefined;
    this.protocol.reset();
    this.releaseAdmission("aborted");
    this.callbacks.onInvalidate("Continuous public feed stopped");
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "idle");
    this.status("stopped", "Continuous public feed stopped");
  }

  private connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.protocol.reset();
    this.callbacks.onInvalidate("Continuous public feed is resynchronizing");
    const source = PUBLIC_STREAM_SOURCES[this.instrument.venue];
    try {
      this.admission = this.governor.acquire(source);
    } catch (error) {
      const state = error instanceof UpstreamCircuitOpenError || error instanceof UpstreamSourceOverloadError ? "overloaded" : "error";
      this.status(state, error instanceof Error ? error.message : "Public stream admission failed");
      this.scheduleReconnect(generation, error instanceof UpstreamCircuitOpenError ? Math.max(1, error.retryAt - this.now()) : undefined);
      return;
    }
    this.status(this.attempt === 0 ? "connecting" : "reconnecting", `${this.instrument.venue} public WebSocket connecting`);
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.protocol.url, this.instrument);
    } catch (error) {
      this.releaseAdmission("failure");
      this.status("error", error instanceof Error ? error.message : "Public WebSocket construction failed");
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    socket.on("open", () => this.onOpen(socket, generation));
    socket.on("message", (raw, isBinary) => this.onMessage(socket, generation, raw, isBinary));
    socket.on("error", (error) => {
      if (this.isCurrent(socket, generation)) this.status("error", `${this.instrument.venue} public socket error: ${error.message}`);
    });
    socket.on("close", () => this.onClose(socket, generation));
  }

  private onOpen(socket: WebSocket, generation: number) {
    if (!this.isCurrent(socket, generation)) return;
    this.lastAcceptedAt = this.now();
    this.status("syncing", `${this.instrument.venue} awaiting public market data`);
    try {
      this.protocol.subscribe(socket, this.now());
    } catch (error) {
      this.breakFeed(socket, error instanceof Error ? error.message : "Public subscription failed");
      return;
    }
    this.startTimers(socket, generation);
    if (this.protocol.needsBootstrap && this.protocol.bootstrapMode !== "protocol-triggered") this.requestBootstrap(socket, generation);
  }

  private onMessage(socket: WebSocket, generation: number, raw: RawData, isBinary = false) {
    if (!this.isCurrent(socket, generation)) return;
    let value: unknown;
    if (isBinary) {
      if (!this.protocol.decodeBinary) {
        this.breakFeed(socket, "Unexpected binary frame on public market-data stream");
        return;
      }
      try {
        value = this.protocol.decodeBinary(rawBytes(raw));
      } catch (error) {
        this.breakFeed(socket, `Malformed binary public market-data frame: ${boundedFrameError(error)}`);
        return;
      }
    } else {
      const text = rawText(raw);
      if (text === "pong") return;
      try {
        value = this.protocol.parse ? this.protocol.parse(text) : JSON.parse(text);
      } catch {
        this.breakFeed(socket, "Malformed JSON on public market-data stream");
        return;
      }
    }
    this.handleResult(socket, generation, this.protocol.push(value, this.now()));
  }

  private handleResult(socket: WebSocket, generation: number, result: ProtocolResult) {
    if (!this.isCurrent(socket, generation) || result.kind === "ignored") return;
    if (result.kind === "gap") {
      this.breakFeed(socket, result.reason);
      return;
    }
    if (result.kind === "accepted") {
      return;
    }
    if (result.kind === "book-advanced") {
      this.acceptTransport(true);
      return;
    }
    if (result.kind === "bootstrap-required") {
      if (!this.protocol.needsBootstrap || this.protocol.bootstrapMode !== "protocol-triggered") {
        this.breakFeed(socket, "Public protocol requested an invalid deferred REST bootstrap");
        return;
      }
      this.requestBootstrap(socket, generation);
      return;
    }
    if (result.kind === "heartbeat") {
      this.lastAcceptedAt = this.now();
      return;
    }
    this.acceptTransport(true);
    if (result.kind === "funding") {
      this.callbacks.onFunding({ ...result.funding, connectionGeneration: generation });
      this.status("live", `${this.instrument.venue} public funding is live`);
      return;
    }
    const book = { ...result.book, connectionGeneration: generation };
    this.callbacks.onBook(book);
    this.callbacks.onTopBook(topBook(book));
    this.status("live", `${this.instrument.venue} public book is live`);
  }

  private requestBootstrap(socket: WebSocket, generation: number) {
    if (!this.isCurrent(socket, generation) || this.bootstrapController) return;
    void this.bootstrap(socket, generation);
  }

  private async bootstrap(socket: WebSocket, generation: number) {
    const adapter = this.adapter;
    const source = publicUpstreamSource(this.instrument.venue);
    if (!adapter || !source) {
      this.breakFeed(socket, "Public REST bootstrap has no governed adapter source");
      return;
    }
    const controller = new AbortController();
    this.bootstrapController = controller;
    try {
      const snapshot = await this.restGovernor.run(source, () => adapter.depth({ instrumentId: this.instrument.venueSymbol, marketType: this.instrument.marketType, limit: 100 }, controller.signal), {
        classifyError: (error) => (controller.signal.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "failure")
      });
      if (!this.isCurrent(socket, generation)) return;
      this.handleResult(socket, generation, this.protocol.applyBootstrap?.(snapshot) ?? { kind: "gap", reason: "Protocol cannot apply its required bootstrap" });
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrent(socket, generation)) return;
      this.breakFeed(socket, error instanceof Error ? error.message : "Public REST bootstrap failed");
    } finally {
      if (this.bootstrapController === controller) this.bootstrapController = undefined;
    }
  }

  private acceptTransport(marketData: boolean) {
    if (marketData) this.lastAcceptedAt = this.now();
    this.attempt = 0;
    if (marketData) this.releaseAdmission("success");
  }

  private startTimers(socket: WebSocket, generation: number) {
    const timeoutMs = this.messageTimeoutMs;
    const heartbeatMs = this.heartbeatMs;
    this.watchdogTimer = setInterval(
      () => {
        if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
        if (this.now() - this.lastAcceptedAt > timeoutMs) this.breakFeed(socket, `${this.instrument.venue} public market data timed out`);
      },
      Math.max(1_000, Math.min(5_000, Math.floor(timeoutMs / 2)))
    );
    this.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
      try {
        this.protocol.heartbeat(socket, this.now());
      } catch {
        this.breakFeed(socket, `${this.instrument.venue} public heartbeat failed`);
      }
    }, heartbeatMs);
    this.watchdogTimer.unref?.();
    this.heartbeatTimer.unref?.();
  }

  private breakFeed(socket: WebSocket, reason: string) {
    if (socket !== this.socket) return;
    this.protocol.reset();
    this.callbacks.onInvalidate(reason);
    this.status("gap", reason);
    if (socket.readyState < WebSocket.CLOSING) socket.terminate();
  }

  private onClose(socket: WebSocket, generation: number) {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = undefined;
    this.clearTimers();
    this.bootstrapController?.abort(new Error("Public stream socket closed"));
    this.bootstrapController = undefined;
    this.protocol.reset();
    this.releaseAdmission("failure");
    this.callbacks.onInvalidate(`${this.instrument.venue} public socket closed`);
    if (this.stopped) return;
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number, exactDelay?: number) {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return;
    this.attempt += 1;
    const base = exactDelay ?? Math.min(30_000, 500 * 2 ** Math.min(this.attempt - 1, 6));
    const delay = exactDelay ?? Math.round(base * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.status("reconnecting", `${this.instrument.venue} public feed reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private releaseAdmission(outcome: "success" | "failure" | "aborted") {
    this.admission?.release(outcome);
    this.admission = undefined;
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.watchdogTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private isCurrent(socket: WebSocket, generation: number) {
    return !this.stopped && socket === this.socket && generation === this.generation;
  }

  private status(state: ContinuousFeedState, message: string) {
    this.callbacks.onStatus({ venue: this.instrument.venue, instrumentId: this.instrument.instrumentId, state, message, generation: this.generation });
  }
}

function topBook(book: ContinuousPublicBook) {
  const bid = book.bids[0]!;
  const ask = book.asks[0]!;
  return {
    venue: book.venue,
    instrumentId: book.instrumentId,
    marketType: book.marketType,
    quantityUnit: book.quantityUnit,
    bid: bid[0],
    bidSize: bid[1],
    ask: ask[0],
    askSize: ask[1],
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt,
    continuity: book.continuity,
    connectionGeneration: book.connectionGeneration
  };
}

function defaultSocket(url: string, instrument: ContinuousFeedInstrument) {
  return new WebSocket(url, publicFeedSocketOptions(instrument));
}

/** Coinbase publishes the initial full L2 in one frame; keep its larger bound explicit and isolated. */
export function publicFeedSocketOptions(instrument: ContinuousFeedInstrument) {
  const headers = instrument.venue === "gate" && instrument.marketType === "perpetual" ? { "X-Gate-Size-Decimal": "1" } : undefined;
  return {
    maxPayload: instrument.venue === "coinbase" ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
    ...(headers ? { headers } : {})
  };
}

function boundedDuration(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new Error(`${label} must be between 100 and 300000`);
  return value;
}

function rawBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function rawText(raw: RawData) {
  return Buffer.from(rawBytes(raw)).toString("utf8");
}

function boundedFrameError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").trim().slice(0, 300) || "binary decoder rejected the frame";
}
