import type { WebSocket } from "ws";
import { ResilientPublicSocket } from "./socket.js";
import type { StatusListener, TickerListener } from "./types.js";

interface BinanceBookTicker {
  s?: unknown;
  b?: unknown;
  B?: unknown;
  a?: unknown;
  A?: unknown;
  E?: unknown;
  T?: unknown;
  st?: unknown;
}

export function parseBinanceBookTicker(value: unknown, market: "spot" | "perpetual", capturedAt = Date.now()) {
  const envelope = object(value);
  const row = object(envelope?.data ?? value) as BinanceBookTicker | undefined;
  if (!row || (market === "perpetual" && row.st !== undefined && Number(row.st) !== 1)) return undefined;
  const symbol = String(row.s ?? "").toUpperCase();
  const bid = positive(row.b);
  const bidSize = positive(row.B);
  const ask = positive(row.a);
  const askSize = positive(row.A);
  if (!validSymbol(symbol) || !bid || !bidSize || !ask || bid >= ask || !askSize) return undefined;
  const venueTimestamp = positive(row.E) ?? positive(row.T);
  return {
    exchange: "binance" as const,
    market,
    symbol,
    bid,
    bidSize,
    ask,
    askSize,
    ...(venueTimestamp === undefined ? {} : { exchangeTs: venueTimestamp }),
    exchangeTimestampVerified: venueTimestamp !== undefined,
    receivedAt: capturedAt,
    capturedAt
  };
}

export class BinanceTickerFeed {
  private symbols: string[] = [];
  private readonly socket: ResilientPublicSocket;

  constructor(market: "spot" | "perpetual", onTicker: TickerListener, onStatus: StatusListener) {
    const url = market === "spot" ? "wss://stream.binance.com:9443/stream" : "wss://fstream.binance.com/public/stream";
    this.socket = new ResilientPublicSocket({
      url,
      name: `Binance ${market}`,
      onOpen: (socket) => subscribeBinance(socket, this.symbols, market),
      onMessage: (value) => {
        const update = parseBinanceBookTicker(value, market);
        if (!update) return false;
        onTicker(update);
        return true;
      },
      onStatus: (ok, message) => onStatus({ exchange: "binance", market, ok, message })
    });
  }

  setSymbols(symbols: Iterable<string>) {
    const next = normalizedSymbols(symbols);
    if (next.join() === this.symbols.join()) return;
    this.symbols = next;
    this.socket.restart();
  }
  start() {
    if (this.symbols.length) this.socket.start();
  }
  stop() {
    this.socket.stop();
  }
}

function subscribeBinance(socket: WebSocket, symbols: string[], market: "spot" | "perpetual") {
  if (!symbols.length) return;
  // Spot bookTicker has updateId but no venue timestamp. The 1s ticker stream
  // contains the same best bid/ask fields plus venue event time E, so it can
  // support a verified freshness gate without synthesizing local time.
  const stream = market === "spot" ? "ticker" : "bookTicker";
  socket.send(JSON.stringify({ method: "SUBSCRIBE", params: symbols.map((symbol) => `${symbol.toLowerCase()}@${stream}`), id: 1 }));
}

function normalizedSymbols(symbols: Iterable<string>) {
  return [...new Set(symbols)].filter(validSymbol).sort().slice(0, 900);
}
function validSymbol(value: string) {
  return /^[A-Z0-9]{2,20}USDT$/.test(value);
}
function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
