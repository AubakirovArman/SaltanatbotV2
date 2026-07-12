import WebSocket from "ws";
import type { OrderBookSnapshotMessage } from "../types.js";
import type { OrderBookConnectorCallbacks, OrderBookSubscription } from "./types.js";
import { parseRawLevels, positiveLevels } from "./types.js";

interface BinancePartialDepth {
  lastUpdateId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export function parseBinancePartialDepth(value: unknown): BinancePartialDepth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const lastUpdateId = Number(input.lastUpdateId);
  const bids = parseRawLevels(input.bids);
  const asks = parseRawLevels(input.asks);
  if (!Number.isSafeInteger(lastUpdateId) || lastUpdateId < 0 || !bids || !asks) return undefined;
  return { lastUpdateId, bids: positiveLevels(bids), asks: positiveLevels(asks) };
}

export function subscribeBinanceOrderBook(
  symbol: string,
  callbacks: OrderBookConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)
): OrderBookSubscription {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", attempts > 0 ? "Binance depth reconnecting" : "Binance depth connecting");
    socket = createSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@depth20@100ms`);
    socket.on("open", () => {
      attempts = 0;
      callbacks.onStatus("connected", "Binance top-20 depth connected");
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const data = parseBinancePartialDepth(raw);
      if (!data) return;
      const now = Date.now();
      const snapshot: OrderBookSnapshotMessage = {
        type: "orderbook",
        symbol,
        exchange: "binance",
        bids: data.bids,
        asks: data.asks,
        sequence: data.lastUpdateId,
        exchangeTs: now,
        ts: now
      };
      callbacks.onSnapshot(snapshot);
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Binance depth error: ${error.message}`);
    });
    socket.on("close", () => {
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Binance depth closed — reconnecting in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
