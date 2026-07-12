import WebSocket from "ws";
import type { OrderBookSnapshotMessage } from "../types.js";
import { LocalOrderBook } from "./localBook.js";
import type { OrderBookConnectorCallbacks, OrderBookSubscription } from "./types.js";
import { parseRawLevels } from "./types.js";

interface BybitDepthEvent {
  type: "snapshot" | "delta";
  ts: number;
  sequence: number;
  updateId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export function parseBybitDepth(value: unknown): BybitDepthEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.type !== "snapshot" && input.type !== "delta") return undefined;
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) return undefined;
  const data = input.data as Record<string, unknown>;
  const bids = parseRawLevels(data.b);
  const asks = parseRawLevels(data.a);
  const ts = Number(input.ts);
  const sequence = Number(data.seq);
  const updateId = Number(data.u);
  if (!bids || !asks || !Number.isFinite(ts) || ts < 0 || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(updateId) || updateId < 0) return undefined;
  return { type: input.type, ts, sequence, updateId, bids, asks };
}

export function subscribeBybitOrderBook(
  symbol: string,
  callbacks: OrderBookConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)
): OrderBookSubscription {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;
  let initialized = false;
  let lastSequence = -1;
  let lastUpdateId = -1;
  const book = new LocalOrderBook();

  const connect = () => {
    initialized = false;
    lastSequence = -1;
    lastUpdateId = -1;
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", attempts > 0 ? "Bybit depth reconnecting" : "Bybit depth connecting");
    socket = createSocket("wss://stream.bybit.com/v5/public/spot");
    socket.on("open", () => {
      attempts = 0;
      socket?.send(JSON.stringify({ op: "subscribe", args: [`orderbook.50.${symbol}`] }));
      callbacks.onStatus("connected", "Bybit level-50 depth connected");
      heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op: "ping" })), 20_000);
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const event = parseBybitDepth(raw);
      if (!event) return;
      if (event.type === "snapshot" || event.updateId === 1) {
        book.reset(event.bids, event.asks);
        initialized = true;
      } else {
        if (!initialized) {
          callbacks.onStatus("stale", "Bybit delta received before snapshot; reconnecting");
          socket?.close();
          return;
        }
        if (event.sequence <= lastSequence || event.updateId <= lastUpdateId) return;
        book.apply(event.bids, event.asks);
      }
      lastSequence = event.sequence;
      lastUpdateId = event.updateId;
      const levels = book.snapshot(20);
      callbacks.onSnapshot({
        type: "orderbook",
        symbol,
        exchange: "bybit",
        bids: levels.bids,
        asks: levels.asks,
        sequence: event.sequence,
        exchangeTs: event.ts,
        ts: Date.now()
      });
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Bybit depth error: ${error.message}`);
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Bybit depth closed — reconnecting in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();
  return {
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
