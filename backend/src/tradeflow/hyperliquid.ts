import WebSocket from "ws";
import { hyperliquidPerpetualCoin } from "../providers/hyperliquid.js";
import type { TradeFlowTrade } from "../types.js";
import { positiveNumber, timestamp, type TradeFlowConnectorCallbacks, type TradeFlowSubscription } from "./types.js";

interface HyperliquidTrade {
  coin?: unknown;
  side?: unknown;
  px?: unknown;
  sz?: unknown;
  hash?: unknown;
  time?: unknown;
  tid?: unknown;
}

export function parseHyperliquidTrades(value: unknown, expectedCoin: string): TradeFlowTrade[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as { channel?: unknown; data?: unknown };
  if (envelope.channel !== "trades" || !Array.isArray(envelope.data)) return undefined;
  const trades: TradeFlowTrade[] = [];
  for (const raw of envelope.data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as HyperliquidTrade;
    const price = positiveNumber(row.px);
    const size = positiveNumber(row.sz);
    const exchangeTs = timestamp(row.time);
    const tid = typeof row.tid === "number" || typeof row.tid === "string" ? String(row.tid) : "";
    if (row.coin !== expectedCoin || !price || !size || exchangeTs === undefined || !tid || (row.side !== "B" && row.side !== "A")) return undefined;
    trades.push({ id: `${exchangeTs}:${expectedCoin}:${tid}`, price, size, side: row.side === "B" ? "buy" : "sell", exchangeTs });
  }
  return trades;
}

export function subscribeHyperliquidTradeFlow(
  symbol: string,
  callbacks: TradeFlowConnectorCallbacks,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })
): TradeFlowSubscription {
  const coin = hyperliquidPerpetualCoin(symbol);
  const subscription = { type: "trades", coin } as const;
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    callbacks.onStatus(attempts > 0 ? "reconnecting" : "connecting", `Hyperliquid public trades ${attempts > 0 ? "reconnecting" : "connecting"}`);
    socket = createSocket("wss://api.hyperliquid.xyz/ws");
    socket.on("open", () => {
      attempts = 0;
      socket?.send(JSON.stringify({ method: "subscribe", subscription }));
      callbacks.onStatus("connected", "Hyperliquid public trades connected");
      heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "ping" })), 30_000);
    });
    socket.on("message", (buffer) => {
      let raw: unknown;
      try { raw = JSON.parse(buffer.toString()); } catch { return; }
      const trades = parseHyperliquidTrades(raw, coin);
      if (trades?.length) callbacks.onTrades(trades);
    });
    socket.on("error", (error) => {
      if (!closed) callbacks.onStatus("error", `Hyperliquid trade flow error: ${error.message}`);
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (closed) return;
      attempts += 1;
      const delay = reconnectDelay(attempts);
      callbacks.onStatus("reconnecting", `Hyperliquid trade flow closed — reconnecting in ${Math.round(delay / 1000)}s`);
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

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
