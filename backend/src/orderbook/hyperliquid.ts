import WebSocket from "ws";
import type { OrderBookSnapshotMessage } from "../types.js";
import { hyperliquidPerpetualCoin } from "../providers/hyperliquid.js";
import type { OrderBookConnectorCallbacks, OrderBookSubscription } from "./types.js";

interface HyperliquidBook {
  coin: string;
  time: number;
  levels: [Array<{ px: string | number; sz: string | number; n?: number }>, Array<{ px: string | number; sz: string | number; n?: number }>];
}

export function parseHyperliquidBook(value: unknown, expectedCoin: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as { channel?: unknown; data?: unknown };
  if (envelope.channel !== "l2Book" || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) return undefined;
  const book = envelope.data as Partial<HyperliquidBook>;
  if (book.coin !== expectedCoin || !Number.isSafeInteger(book.time) || Number(book.time) < 0 || !Array.isArray(book.levels) || book.levels.length !== 2) return undefined;
  const bids = levels(book.levels[0], true);
  const asks = levels(book.levels[1], false);
  if (!bids || !asks || bids.length === 0 || asks.length === 0 || bids[0]![0] >= asks[0]![0]) return undefined;
  return { exchangeTs: Number(book.time), bids, asks };
}

/** Display-only atomic HyperCore block snapshots; no sequence/checksum is claimed. */
export function subscribeHyperliquidOrderBook(
  symbol: string,
  callbacks: OrderBookConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })
): OrderBookSubscription {
  const coin = hyperliquidPerpetualCoin(symbol);
  const subscription = { type: "l2Book", coin } as const;
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", attempts > 0 ? "Hyperliquid depth reconnecting" : "Hyperliquid depth connecting");
    socket = createSocket("wss://api.hyperliquid.xyz/ws");
    socket.on("open", () => {
      attempts = 0;
      socket?.send(JSON.stringify({ method: "subscribe", subscription }));
      callbacks.onStatus("connected", "Hyperliquid atomic top-20 depth connected");
      heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "ping" })), 30_000);
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const book = parseHyperliquidBook(raw, coin);
      if (!book) return;
      const snapshot: OrderBookSnapshotMessage = {
        type: "orderbook",
        symbol,
        exchange: "hyperliquid",
        bids: book.bids,
        asks: book.asks,
        // Hyperliquid publishes independent block snapshots without a protocol sequence.
        // The browser contract requires a monotonic numeric identity, so exchange time is
        // used only for snapshot replacement and is never exposed as sequence proof.
        sequence: book.exchangeTs,
        exchangeTs: book.exchangeTs,
        ts: Date.now()
      };
      callbacks.onSnapshot(snapshot);
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Hyperliquid depth error: ${error.message}`);
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Hyperliquid depth closed — reconnecting in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();
  return {
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: "unsubscribe", subscription }));
      socket?.close();
    }
  };
}

function levels(value: unknown, descending: boolean): Array<[number, number]> | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const parsed: Array<[number, number]> = [];
  let previous: number | undefined;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as { px?: unknown; sz?: unknown };
    const price = Number(row.px);
    const size = Number(row.sz);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return undefined;
    if (previous !== undefined && (descending ? price >= previous : price <= previous)) return undefined;
    parsed.push([price, size]);
    previous = price;
  }
  return parsed;
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
