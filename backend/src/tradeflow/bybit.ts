import WebSocket from "ws";
import type { TradeFlowTrade } from "../types.js";
import { positiveNumber, timestamp, type TradeFlowConnectorCallbacks, type TradeFlowSubscription } from "./types.js";

export function parseBybitPublicTrades(value: unknown): TradeFlowTrade[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.topic !== "string" || !input.topic.startsWith("publicTrade.") || !Array.isArray(input.data)) return undefined;
  const trades: TradeFlowTrade[] = [];
  for (const raw of input.data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as Record<string, unknown>;
    const price = positiveNumber(row.p);
    const size = positiveNumber(row.v);
    const exchangeTs = timestamp(row.T);
    const id = typeof row.i === "string" || typeof row.i === "number" ? String(row.i) : "";
    if (!price || !size || exchangeTs === undefined || !id || (row.S !== "Buy" && row.S !== "Sell")) return undefined;
    // Bybit S is the taker side, so it maps directly to aggressor direction.
    trades.push({ id, price, size, side: row.S === "Buy" ? "buy" : "sell", exchangeTs });
  }
  return trades;
}

export function subscribeBybitTradeFlow(
  symbol: string,
  callbacks: TradeFlowConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })
): TradeFlowSubscription {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", `Bybit public trades ${attempts > 0 ? "reconnecting" : "connecting"}`);
    socket = createSocket("wss://stream.bybit.com/v5/public/spot");
    socket.on("open", () => {
      attempts = 0;
      socket?.send(JSON.stringify({ op: "subscribe", args: [`publicTrade.${symbol}`] }));
      callbacks.onStatus("connected", "Bybit public trades connected");
      heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op: "ping" })), 20_000);
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const trades = parseBybitPublicTrades(raw);
      if (trades?.length) callbacks.onTrades(trades);
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Bybit trade flow error: ${error.message}`);
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Bybit trade flow closed — reconnecting in ${Math.round(delay / 1000)}s`);
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
