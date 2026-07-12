import { randomUUID } from "node:crypto";
import type { DataExchange, OrderBookSnapshotMessage, OrderBookStatusMessage, OrderBookStreamMessage } from "../types.js";
import { subscribeBinanceOrderBook } from "./binance.js";
import { subscribeBybitOrderBook } from "./bybit.js";
import type { OrderBookConnector, OrderBookSubscription } from "./types.js";

interface SharedBook {
  listeners: Map<string, (message: OrderBookStreamMessage) => void>;
  upstream?: OrderBookSubscription;
  lastSnapshot?: OrderBookSnapshotMessage;
  lastStatus?: OrderBookStatusMessage;
  pending?: OrderBookSnapshotMessage;
  timer?: NodeJS.Timeout;
  lastPublishAt: number;
}

export class OrderBookHub {
  private books = new Map<string, SharedBook>();

  constructor(
    private readonly connector: OrderBookConnector = defaultConnector,
    private readonly throttleMs = 250,
    private readonly clock: () => number = Date.now,
    private readonly maxBooks = 32
  ) {}

  subscribe(exchange: DataExchange, symbol: string, listener: (message: OrderBookStreamMessage) => void): OrderBookSubscription {
    const key = `${exchange}:${symbol}`;
    let shared = this.books.get(key);
    if (!shared) {
      if (this.books.size >= this.maxBooks) throw new Error(`Order book stream limit reached (${this.maxBooks})`);
      shared = { listeners: new Map(), lastPublishAt: 0 };
      this.books.set(key, shared);
      const target = shared;
      try {
        target.upstream = this.connector(exchange, symbol, {
          onSnapshot: (snapshot) => this.queueSnapshot(target, snapshot),
          onStatus: (status, message) => {
            const envelope: OrderBookStatusMessage = { type: "orderbook_status", symbol, exchange, status, message, ts: this.clock() };
            target.lastStatus = envelope;
            this.broadcast(target, envelope);
          }
        });
      } catch (error) {
        const envelope: OrderBookStatusMessage = {
          type: "orderbook_status", symbol, exchange, status: "error",
          message: error instanceof Error ? error.message : "Order book connector failed", ts: this.clock()
        };
        target.lastStatus = envelope;
      }
    }

    const id = randomUUID();
    shared.listeners.set(id, listener);
    if (shared.lastStatus) listener(shared.lastStatus);
    if (shared.lastSnapshot) listener(shared.lastSnapshot);
    return {
      close: () => {
        const current = this.books.get(key);
        if (!current) return;
        current.listeners.delete(id);
        if (current.listeners.size > 0) return;
        if (current.timer) clearTimeout(current.timer);
        current.upstream?.close();
        this.books.delete(key);
      }
    };
  }

  activeBooks() {
    return this.books.size;
  }

  private queueSnapshot(shared: SharedBook, snapshot: OrderBookSnapshotMessage) {
    shared.pending = snapshot;
    const elapsed = this.clock() - shared.lastPublishAt;
    if (elapsed >= this.throttleMs) {
      this.flush(shared);
      return;
    }
    if (!shared.timer) shared.timer = setTimeout(() => this.flush(shared), this.throttleMs - elapsed);
  }

  private flush(shared: SharedBook) {
    if (shared.timer) clearTimeout(shared.timer);
    shared.timer = undefined;
    const snapshot = shared.pending;
    if (!snapshot) return;
    shared.pending = undefined;
    shared.lastPublishAt = this.clock();
    shared.lastSnapshot = snapshot;
    this.broadcast(shared, snapshot);
  }

  private broadcast(shared: SharedBook, message: OrderBookStreamMessage) {
    for (const listener of shared.listeners.values()) listener(message);
  }
}

const defaultConnector: OrderBookConnector = (exchange, symbol, callbacks) => exchange === "bybit"
  ? subscribeBybitOrderBook(symbol, callbacks)
  : subscribeBinanceOrderBook(symbol, callbacks);
