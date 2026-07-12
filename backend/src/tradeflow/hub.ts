import { randomUUID } from "node:crypto";
import type { DataExchange, TradeFlowBatchMessage, TradeFlowStatusMessage, TradeFlowStreamMessage, TradeFlowTrade } from "../types.js";
import { subscribeBinanceTradeFlow } from "./binance.js";
import { subscribeBybitTradeFlow } from "./bybit.js";
import type { TradeFlowConnector, TradeFlowSubscription } from "./types.js";

interface SharedFlow {
  listeners: Map<string, (message: TradeFlowStreamMessage) => void>;
  upstream?: TradeFlowSubscription;
  lastStatus?: TradeFlowStatusMessage;
  pending: TradeFlowTrade[];
  timer?: NodeJS.Timeout;
}

export class TradeFlowHub {
  private flows = new Map<string, SharedFlow>();

  constructor(
    private readonly connector: TradeFlowConnector = defaultConnector,
    private readonly batchMs = 100,
    private readonly clock: () => number = Date.now,
    private readonly maxFlows = 32
  ) {}

  subscribe(exchange: DataExchange, symbol: string, listener: (message: TradeFlowStreamMessage) => void): TradeFlowSubscription {
    const key = `${exchange}:${symbol}`;
    let shared = this.flows.get(key);
    if (!shared) {
      if (this.flows.size >= this.maxFlows) throw new Error(`Trade flow stream limit reached (${this.maxFlows})`);
      shared = { listeners: new Map(), pending: [] };
      this.flows.set(key, shared);
      const target = shared;
      try {
        target.upstream = this.connector(exchange, symbol, {
          onTrades: (trades) => this.queue(target, symbol, exchange, trades),
          onStatus: (status, message) => {
            const envelope: TradeFlowStatusMessage = { type: "trade_flow_status", symbol, exchange, status, message, ts: this.clock() };
            target.lastStatus = envelope;
            this.broadcast(target, envelope);
          }
        });
      } catch (error) {
        target.lastStatus = {
          type: "trade_flow_status", symbol, exchange, status: "error",
          message: error instanceof Error ? error.message : "Trade flow connector failed", ts: this.clock()
        };
      }
    }

    const id = randomUUID();
    shared.listeners.set(id, listener);
    if (shared.lastStatus) listener(shared.lastStatus);
    return {
      close: () => {
        const current = this.flows.get(key);
        if (!current) return;
        current.listeners.delete(id);
        if (current.listeners.size > 0) return;
        if (current.timer) clearTimeout(current.timer);
        current.upstream?.close();
        this.flows.delete(key);
      }
    };
  }

  activeFlows() { return this.flows.size; }

  private queue(shared: SharedFlow, symbol: string, exchange: DataExchange, trades: TradeFlowTrade[]) {
    shared.pending.push(...trades);
    while (shared.pending.length >= 500) this.flush(shared, symbol, exchange, 500);
    if (!shared.timer && shared.pending.length > 0) shared.timer = setTimeout(() => this.flush(shared, symbol, exchange), this.batchMs);
  }

  private flush(shared: SharedFlow, symbol: string, exchange: DataExchange, limit = 500) {
    if (shared.timer) clearTimeout(shared.timer);
    shared.timer = undefined;
    if (shared.pending.length === 0) return;
    const trades = shared.pending.splice(0, limit);
    const envelope: TradeFlowBatchMessage = { type: "trade_flow", symbol, exchange, trades, ts: this.clock() };
    this.broadcast(shared, envelope);
    if (shared.pending.length > 0) shared.timer = setTimeout(() => this.flush(shared, symbol, exchange), 0);
  }

  private broadcast(shared: SharedFlow, message: TradeFlowStreamMessage) {
    for (const listener of shared.listeners.values()) listener(message);
  }
}

const defaultConnector: TradeFlowConnector = (exchange, symbol, callbacks) => exchange === "bybit"
  ? subscribeBybitTradeFlow(symbol, callbacks)
  : subscribeBinanceTradeFlow(symbol, callbacks);
