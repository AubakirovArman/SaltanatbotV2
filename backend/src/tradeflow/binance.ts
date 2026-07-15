import WebSocket from "ws";
import type { TradeFlowTrade } from "../types.js";
import { positiveNumber, timestamp, type TradeFlowConnectorCallbacks, type TradeFlowSubscription } from "./types.js";

export function parseBinanceAggregateTrade(value: unknown): TradeFlowTrade | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.e !== "aggTrade" || typeof input.m !== "boolean") return undefined;
  const price = positiveNumber(input.p);
  const size = positiveNumber(input.q);
  const exchangeTs = timestamp(input.T);
  const id = typeof input.a === "number" || typeof input.a === "string" ? String(input.a) : "";
  if (!price || !size || exchangeTs === undefined || !id) return undefined;
  // m=true means the buyer was resting, therefore the aggressive taker sold.
  return { id, price, size, side: input.m ? "sell" : "buy", exchangeTs };
}

export function subscribeBinanceTradeFlow(
  symbol: string,
  callbacks: TradeFlowConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })
): TradeFlowSubscription {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", `Binance aggregate trades ${attempts > 0 ? "reconnecting" : "connecting"}`);
    socket = createSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@aggTrade`);
    socket.on("open", () => {
      attempts = 0;
      callbacks.onStatus("connected", "Binance aggregate trades connected");
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const trade = parseBinanceAggregateTrade(raw);
      if (trade) callbacks.onTrades([trade]);
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Binance trade flow error: ${error.message}`);
    });
    socket.on("close", () => {
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Binance trade flow closed — reconnecting in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();
  return { close() { closed = true; if (reconnectTimer) clearTimeout(reconnectTimer); socket?.close(); } };
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
