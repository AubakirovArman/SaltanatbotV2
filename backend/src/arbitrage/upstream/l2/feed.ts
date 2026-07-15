import WebSocket from "ws";
import type { RawData } from "ws";
import { readBoundedText } from "../../../http/boundedResponse.js";
import { linkedAbortSignal } from "../../sharedAbortableWork.js";
import type { ArbitrageExchange, ArbitrageMarket } from "../../types.js";
import { BinanceDepthReconstructor, parseBinanceDepthDelta, parseBinanceDepthSnapshot } from "./binanceProtocol.js";
import { createBybitLinearDepthReconstructor, createBybitSpotDepthReconstructor, parseBybitDepthEvent, type BybitDepthReconstructor } from "./bybitProtocol.js";
import type { L2ReconstructionResult, SequenceVerifiedL2Callbacks, SequenceVerifiedL2Subscription } from "./types.js";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_RETRIES = 3;

interface SequenceVerifiedL2FeedOptions {
  fetch?: typeof fetch;
  createSocket?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
  snapshotTimeoutMs?: number;
  messageTimeoutMs?: number;
  maxLevels?: number;
  publishLevels?: number;
}

/** One bounded public book lifecycle. It never opens a private/authenticated channel. */
export class SequenceVerifiedL2Feed implements SequenceVerifiedL2Subscription {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly binance?: BinanceDepthReconstructor;
  private readonly bybit?: BybitDepthReconstructor;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private snapshotController?: AbortController;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private lastMarketMessageAt = 0;

  constructor(
    readonly exchange: ArbitrageExchange,
    readonly market: ArbitrageMarket,
    readonly symbol: string,
    private readonly callbacks: SequenceVerifiedL2Callbacks,
    private readonly options: SequenceVerifiedL2FeedOptions = {}
  ) {
    if (!/^[A-Z0-9-]{2,32}$/.test(symbol)) throw new Error("Invalid sequence-verified L2 symbol");
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url, { maxPayload: 4 * 1024 * 1024 }));
    if (exchange === "binance") {
      this.binance = new BinanceDepthReconstructor(market, symbol, { maxLevels: options.maxLevels, publishLevels: options.publishLevels });
    } else {
      const factory = market === "spot" ? createBybitSpotDepthReconstructor : createBybitLinearDepthReconstructor;
      this.bybit = factory(symbol, { maxLevels: options.maxLevels ?? 200, publishLevels: options.publishLevels });
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
    this.snapshotController?.abort(new Error("L2 feed stopped"));
    this.snapshotController = undefined;
    this.binance?.reset();
    this.bybit?.reset();
    this.callbacks.onInvalidate("Sequence-verified L2 feed stopped");
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "idle");
    this.status("stopped", "Sequence-verified L2 feed stopped");
  }

  private connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.snapshotController?.abort(new Error("L2 generation replaced"));
    this.snapshotController = undefined;
    this.binance?.reset();
    this.bybit?.reset();
    this.callbacks.onInvalidate("Sequence-verified L2 is resynchronizing");
    this.status(this.attempt === 0 ? "connecting" : "reconnecting", `${this.label()} public depth connecting`);
    const socket = this.createSocket(socketUrl(this.exchange, this.market));
    this.socket = socket;
    socket.on("open", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastMarketMessageAt = this.now();
      this.status("syncing", `${this.label()} awaiting an authoritative snapshot bridge`);
      subscribe(socket, this.exchange, this.market, this.symbol);
      this.startTimers(socket, generation);
      if (this.binance) void this.bootstrapBinance(generation, 0);
    });
    socket.on("message", (raw) => this.onMessage(socket, generation, raw));
    socket.on("error", (error) => {
      if (this.isCurrent(socket, generation)) this.status("error", `${this.label()} depth socket error: ${error.message}`);
    });
    socket.on("close", () => this.onClose(socket, generation));
  }

  private onMessage(socket: WebSocket, generation: number, raw: RawData) {
    if (!this.isCurrent(socket, generation)) return;
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      this.breakBook(socket, "Malformed JSON on a depth stream");
      return;
    }
    const receivedAt = this.now();
    const subscriptionFailure = readSubscriptionFailure(value, this.exchange);
    if (subscriptionFailure) {
      this.breakBook(socket, subscriptionFailure);
      return;
    }
    if (this.binance) {
      const delta = parseBinanceDepthDelta(value, this.market, receivedAt);
      if (!delta) {
        if (looksLikeBinanceDepth(value)) this.breakBook(socket, "Malformed Binance depth delta");
        return;
      }
      this.lastMarketMessageAt = receivedAt;
      this.handleResult(socket, this.binance.push(delta), generation);
      return;
    }
    const event = parseBybitDepthEvent(value, receivedAt);
    if (!event) {
      if (looksLikeBybitDepth(value)) this.breakBook(socket, "Malformed Bybit depth event");
      return;
    }
    this.lastMarketMessageAt = receivedAt;
    this.handleResult(socket, this.bybit?.push(event) ?? { kind: "gap", reason: "Bybit reconstructor is unavailable" }, generation);
  }

  private handleResult(socket: WebSocket, result: L2ReconstructionResult, generation: number) {
    if (!this.isCurrent(socket, generation)) return;
    if (result.kind === "ready") {
      this.attempt = 0;
      this.callbacks.onBook({ ...result.book, connectionGeneration: generation });
      this.status("live", `${this.label()} sequence-verified L2 is live`);
    } else if (result.kind === "retry-snapshot") {
      this.status("syncing", result.reason);
      if (!this.snapshotController) void this.bootstrapBinance(generation, 1);
    } else if (result.kind === "gap") {
      this.breakBook(socket, result.reason);
    }
  }

  private async bootstrapBinance(generation: number, retry: number): Promise<void> {
    if (!this.binance || this.stopped || generation !== this.generation) return;
    if (retry >= MAX_SNAPSHOT_RETRIES) {
      if (this.socket) this.breakBook(this.socket, "Binance snapshot could not bridge the buffered diff-depth stream");
      return;
    }
    const controller = new AbortController();
    this.snapshotController?.abort(new Error("Binance snapshot superseded"));
    this.snapshotController = controller;
    const linked = linkedAbortSignal(controller.signal, this.options.snapshotTimeoutMs ?? 8_000, "Binance depth snapshot timed out");
    try {
      const response = await this.fetcher(snapshotUrl(this.market, this.symbol), { signal: linked.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Binance depth snapshot HTTP ${response.status}`);
      const text = await readBoundedText(response, MAX_SNAPSHOT_BYTES, () => new Error("Binance depth snapshot is too large"));
      if (this.stopped || generation !== this.generation) return;
      const snapshot = parseBinanceDepthSnapshot(JSON.parse(text), this.now());
      if (!snapshot) throw new Error("Binance depth snapshot is malformed");
      const result = this.binance.applySnapshot(snapshot);
      if (result.kind === "retry-snapshot") {
        await this.bootstrapBinance(generation, retry + 1);
        return;
      }
      if (this.socket) this.handleResult(this.socket, result, generation);
    } catch (error) {
      if (this.stopped || generation !== this.generation || controller.signal.aborted) return;
      if (retry + 1 < MAX_SNAPSHOT_RETRIES) {
        await this.bootstrapBinance(generation, retry + 1);
      } else if (this.socket) {
        this.breakBook(this.socket, error instanceof Error ? error.message : "Binance depth snapshot failed");
      }
    } finally {
      linked.cleanup();
      if (this.snapshotController === controller) this.snapshotController = undefined;
    }
  }

  private startTimers(socket: WebSocket, generation: number) {
    this.watchdogTimer = setInterval(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
      if (this.now() - this.lastMarketMessageAt > (this.options.messageTimeoutMs ?? 30_000)) this.breakBook(socket, `${this.label()} depth stream timed out`);
    }, 5_000);
    this.watchdogTimer.unref?.();
    if (this.exchange === "bybit") {
      this.heartbeatTimer = setInterval(() => {
        if (this.isCurrent(socket, generation) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
      }, 20_000);
      this.heartbeatTimer.unref?.();
    }
  }

  private breakBook(socket: WebSocket, reason: string) {
    if (socket !== this.socket) return;
    this.binance?.reset();
    this.bybit?.reset();
    this.callbacks.onInvalidate(reason);
    this.status("gap", reason);
    if (socket.readyState < WebSocket.CLOSING) socket.terminate();
  }

  private onClose(socket: WebSocket, generation: number) {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = undefined;
    this.clearTimers();
    this.snapshotController?.abort(new Error("Depth socket closed"));
    this.snapshotController = undefined;
    this.binance?.reset();
    this.bybit?.reset();
    this.callbacks.onInvalidate(`${this.label()} depth socket closed`);
    if (this.stopped) return;
    this.attempt += 1;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.attempt - 1, 6));
    const delay = Math.round(base * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.status("reconnecting", `${this.label()} depth reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
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

  private status(state: Parameters<SequenceVerifiedL2Callbacks["onStatus"]>[0]["state"], message: string) {
    this.callbacks.onStatus({ exchange: this.exchange, market: this.market, symbol: this.symbol, state, message });
  }

  private label() {
    return `${this.exchange === "binance" ? "Binance" : "Bybit"} ${this.market === "spot" ? "Spot" : "Linear"}`;
  }
}

function socketUrl(exchange: ArbitrageExchange, market: ArbitrageMarket) {
  if (exchange === "binance") return market === "spot" ? "wss://stream.binance.com:9443/stream" : "wss://fstream.binance.com/public/stream";
  return `wss://stream.bybit.com/v5/public/${market === "spot" ? "spot" : "linear"}`;
}

function subscribe(socket: WebSocket, exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string) {
  if (exchange === "binance") {
    socket.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${symbol.toLowerCase()}@depth@100ms`], id: 1 }));
  } else {
    socket.send(JSON.stringify({ op: "subscribe", args: [`orderbook.200.${symbol}`], req_id: `arb-l2-${market}-${symbol}` }));
  }
}

function snapshotUrl(market: ArbitrageMarket, symbol: string) {
  const base = market === "spot" ? "https://api.binance.com/api/v3/depth" : "https://fapi.binance.com/fapi/v1/depth";
  return `${base}?symbol=${encodeURIComponent(symbol)}&limit=1000`;
}

function looksLikeBinanceDepth(value: unknown) {
  const envelope = object(value);
  const row = object(envelope?.data ?? value);
  return row?.e === "depthUpdate" || ("U" in (row ?? {}) && "u" in (row ?? {}));
}

function looksLikeBybitDepth(value: unknown) {
  const row = object(value);
  return typeof row?.topic === "string" && row.topic.startsWith("orderbook.");
}

function readSubscriptionFailure(value: unknown, exchange: ArbitrageExchange) {
  const row = object(value);
  if (!row) return undefined;
  if (exchange === "binance" && Number.isFinite(Number(row.code)) && typeof row.msg === "string") return `Binance depth subscription failed: ${row.msg}`;
  if (exchange === "bybit" && row.success === false) {
    const message = typeof row.ret_msg === "string" ? row.ret_msg : typeof row.retMsg === "string" ? row.retMsg : "subscription rejected";
    return `Bybit depth subscription failed: ${message}`;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
