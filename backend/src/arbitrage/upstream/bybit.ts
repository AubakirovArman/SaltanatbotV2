import type { WebSocket } from "ws";
import { ResilientPublicSocket } from "./socket.js";
import type { StatusListener, TickerListener } from "./types.js";

interface BybitTicker {
  symbol?: unknown;
  bid1Price?: unknown;
  bid1Size?: unknown;
  ask1Price?: unknown;
  ask1Size?: unknown;
  fundingRate?: unknown;
  nextFundingTime?: unknown;
}

export function parseBybitTicker(value: unknown, market: "spot" | "perpetual", capturedAt = Date.now(), previous?: BybitTicker) {
  const envelope = object(value);
  if (!envelope || typeof envelope.topic !== "string" || !envelope.topic.startsWith("tickers.")) return undefined;
  const delta = object(envelope.data) as BybitTicker | undefined;
  if (!delta) return undefined;
  const row = { ...previous, ...delta };
  const symbol = String(row.symbol ?? envelope.topic.slice(8)).toUpperCase();
  const bid = positive(row.bid1Price);
  const bidSize = positive(row.bid1Size);
  const ask = positive(row.ask1Price);
  const askSize = positive(row.ask1Size);
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !bid || !bidSize || !ask || !askSize) return undefined;
  const fundingRate = finite(row.fundingRate);
  const nextFundingTime = positive(row.nextFundingTime);
  return {
    exchange: "bybit" as const,
    market,
    symbol,
    bid,
    bidSize,
    ask,
    askSize,
    ...(market === "perpetual" && fundingRate !== undefined ? { fundingRate } : {}),
    ...(market === "perpetual" && nextFundingTime ? { nextFundingTime } : {}),
    capturedAt: positive(envelope.ts) ?? capturedAt
  };
}

export class BybitTickerFeed {
  private symbols: string[] = [];
  private readonly latest = new Map<string, BybitTicker>();
  private readonly socket: ResilientPublicSocket;

  constructor(market: "spot" | "perpetual", onTicker: TickerListener, onStatus: StatusListener) {
    const category = market === "spot" ? "spot" : "linear";
    this.socket = new ResilientPublicSocket({
      url: `wss://stream.bybit.com/v5/public/${category}`,
      name: `Bybit ${market}`,
      onOpen: (socket) => subscribeBybit(socket, this.symbols, market === "spot" ? 10 : 100),
      onMessage: (value) => {
        const envelope = object(value);
        const symbol = typeof envelope?.topic === "string" ? envelope.topic.slice(8).toUpperCase() : "";
        const delta = object(envelope?.data) as BybitTicker | undefined;
        if (!symbol || !delta) return;
        const merged = { ...this.latest.get(symbol), ...delta, symbol };
        this.latest.set(symbol, merged);
        const update = parseBybitTicker(value, market, Date.now(), this.latest.get(symbol));
        if (update) onTicker(update);
      },
      onStatus: (ok, message) => onStatus({ exchange: "bybit", market, ok, message }),
      heartbeat: (socket) => socket.send(JSON.stringify({ op: "ping" }))
    });
  }

  setSymbols(symbols: Iterable<string>) {
    const next = [...new Set(symbols)]
      .filter((value) => /^[A-Z0-9]{2,20}USDT$/.test(value))
      .sort()
      .slice(0, 900);
    if (next.join() === this.symbols.join()) return;
    this.symbols = next;
    this.latest.clear();
    this.socket.restart();
  }
  start() {
    if (this.symbols.length) this.socket.start();
  }
  stop() {
    this.socket.stop();
  }
}

function subscribeBybit(socket: WebSocket, symbols: string[], size: number) {
  for (let offset = 0; offset < symbols.length; offset += size) {
    socket.send(JSON.stringify({ req_id: `arb-${offset / size + 1}`, op: "subscribe", args: symbols.slice(offset, offset + size).map((symbol) => `tickers.${symbol}`) }));
  }
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function finite(value: unknown) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
