import WebSocket from "ws";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { timeframeMs } from "../market/timeframes.js";
import { HyperliquidInfoTransport } from "../venues/hyperliquid/transport.js";
import type { CandleRange, MarketProvider, MarketRouteOptions, MarketSubscription } from "./provider.js";

interface HyperliquidCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string | number;
  c: string | number;
  h: string | number;
  l: string | number;
  v: string | number;
  n: number;
}

interface HyperliquidWsEnvelope {
  channel?: string;
  data?: unknown;
}

const MAX_CANDLES = 1_000;
const WS_URL = "wss://api.hyperliquid.xyz/ws";

/** Credential-free first-DEX HyperCore perpetual candles for the chart/paper data plane. */
export class HyperliquidProvider implements MarketProvider {
  readonly name = "Hyperliquid public";
  private readonly transport: Pick<HyperliquidInfoTransport, "post">;

  constructor(transport: Pick<HyperliquidInfoTransport, "post"> = new HyperliquidInfoTransport()) {
    this.transport = transport;
  }

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, options: MarketRouteOptions = {}) {
    assertRoute(options);
    const coin = hyperliquidPerpetualCoin(instrument);
    const intervalMs = timeframeMs[timeframe];
    const limit = Math.min(MAX_CANDLES, Math.max(1, Math.trunc(range.limit)));
    const endTime = range.endTime ?? Date.now();
    const startTime = range.startTime ?? Math.max(0, endTime - intervalMs * (limit + 2));
    const raw = await this.transport.post({
      type: "candleSnapshot",
      req: { coin, interval: timeframe, startTime, endTime }
    }, options.signal);
    if (!Array.isArray(raw)) throw new Error("Hyperliquid candle response must be an array");
    const candles = raw.map((row, index) => parseHyperliquidCandle(row, coin, timeframe, `candles[${index}]`));
    return candles
      .filter((candle) => candle.time >= startTime && candle.time <= endTime)
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    options: MarketRouteOptions = {}
  ): Promise<MarketSubscription> {
    assertRoute(options);
    const coin = hyperliquidPerpetualCoin(instrument);
    const subscription = { type: "candle", coin, interval: timeframe } as const;
    let socket: WebSocket | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let attempts = 0;
    let lastTime = 0;
    let closed = false;

    const backfill = async () => {
      if (lastTime === 0) return;
      try {
        const candles = await this.getCandles(instrument, timeframe, { limit: MAX_CANDLES, startTime: lastTime }, options);
        for (const candle of candles) if (candle.time >= lastTime) onCandle(candle);
      } catch {
        // A failed reconnect backfill is explicit in status but does not stop live recovery.
        onStatus?.("Hyperliquid reconnect backfill unavailable");
      }
    };

    const connect = () => {
      socket = new WebSocket(WS_URL, { maxPayload: 2 * 1024 * 1024 });
      socket.on("open", () => {
        const reconnected = attempts > 0;
        attempts = 0;
        socket?.send(JSON.stringify({ method: "subscribe", subscription }));
        onStatus?.(reconnected ? "Hyperliquid websocket reconnected" : "Hyperliquid websocket connected");
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: "ping" }));
        }, 30_000);
        if (reconnected) void backfill();
      });
      socket.on("message", (buffer) => {
        let envelope: HyperliquidWsEnvelope;
        try {
          envelope = JSON.parse(buffer.toString()) as HyperliquidWsEnvelope;
        } catch {
          return;
        }
        if (envelope.channel !== "candle") return;
        const rows = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
        for (const row of rows) {
          try {
            const candle = parseHyperliquidCandle(row, coin, timeframe, "websocket candle");
            lastTime = Math.max(lastTime, candle.time);
            onCandle(candle);
          } catch {
            // Ignore malformed upstream rows; a later valid candle keeps the stream usable.
          }
        }
      });
      socket.on("error", (error) => {
        if (!closed) onStatus?.(`Hyperliquid websocket error: ${error.message}`);
      });
      socket.on("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        if (closed) return;
        attempts += 1;
        const delay = reconnectDelay(attempts);
        onStatus?.(`Hyperliquid websocket closed — reconnecting in ${Math.round(delay / 1000)}s`);
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
}

export function hyperliquidPerpetualCoin(instrument: Instrument | string): string {
  const symbol = typeof instrument === "string" ? instrument : instrument.symbol;
  const currency = typeof instrument === "string" ? "USDT" : instrument.currency.toUpperCase();
  const upper = symbol.trim().toUpperCase();
  const suffix = upper.endsWith(currency) ? currency : upper.endsWith("USDT") ? "USDT" : upper.endsWith("USDC") ? "USDC" : "";
  const coin = suffix ? upper.slice(0, -suffix.length) : upper;
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(coin)) throw new Error(`Unsupported Hyperliquid chart symbol: ${symbol}`);
  return coin;
}

export function parseHyperliquidCandle(value: unknown, coin: string, timeframe: Timeframe, label = "candle"): Candle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const row = value as Partial<HyperliquidCandle>;
  if (row.s !== coin || row.i !== timeframe) throw new Error(`${label} identity does not match ${coin} ${timeframe}`);
  const time = integer(row.t, `${label}.t`);
  const closeTime = integer(row.T, `${label}.T`);
  const open = positive(row.o, `${label}.o`);
  const high = positive(row.h, `${label}.h`);
  const low = positive(row.l, `${label}.l`);
  const close = positive(row.c, `${label}.c`);
  const volume = nonnegative(row.v, `${label}.v`);
  if (closeTime < time || low > Math.min(open, close) || high < Math.max(open, close) || low > high) throw new Error(`${label} OHLC range is invalid`);
  return { time, open, high, low, close, volume, final: closeTime < Date.now(), source: "Hyperliquid public" };
}

function assertRoute(options: MarketRouteOptions) {
  if ((options.marketType ?? "linear") !== "linear") throw new Error("Hyperliquid chart integration currently supports first-DEX perpetuals only");
  if ((options.priceType ?? "last") !== "last") throw new Error("Hyperliquid chart integration currently supports trade-price candles only");
}

function integer(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function positive(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function nonnegative(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
}
