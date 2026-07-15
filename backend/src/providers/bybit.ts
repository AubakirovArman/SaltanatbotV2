import WebSocket from "ws";
import { readBoundedText } from "../http/boundedResponse.js";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { bybitIntervals, timeframeMs } from "../market/timeframes.js";
import { fetchWithRetry } from "./http.js";
import type { CandleRange, MarketProvider, MarketRouteOptions, MarketSubscription } from "./provider.js";

type BybitKline = [string, string, string, string, string, string, string];

interface BybitKlineMessage {
  topic?: string;
  data?: Array<{
    start: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    confirm: boolean;
  }>;
}

const MAX_CANDLE_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Public Bybit v5 market data (spot/linear/inverse klines REST + WS). No API keys needed. */
export class BybitProvider implements MarketProvider {
  readonly name = "Bybit public";

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, options: MarketRouteOptions = {}) {
    const interval = bybitIntervals[timeframe];
    if (!interval) throw new Error(`Unsupported Bybit timeframe: ${timeframe}`);
    if ((options.priceType ?? "last") !== "last") throw new Error(`Bybit ${options.priceType} candles are not wired yet`);
    const category = bybitCategory(options.marketType);
    const url = new URL("https://api.bybit.com/v5/market/kline");
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", instrument.symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(Math.min(range.limit, 1000)));
    if (range.endTime !== undefined) url.searchParams.set("end", String(range.endTime));
    if (range.startTime !== undefined) url.searchParams.set("start", String(range.startTime));

    const response = await fetchWithRetry(url);
    if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
    const body = await readBoundedText(response, MAX_CANDLE_PAYLOAD_BYTES, () => new Error("Bybit candle response is too large"));
    const payload = JSON.parse(body) as { retCode: number; retMsg: string; result?: { list?: BybitKline[] } };
    if (payload.retCode !== 0) throw new Error(`Bybit: ${payload.retMsg}`);
    const list = payload.result?.list ?? [];
    // Bybit returns newest-first; reverse to ascending time.
    return list
      .map((item) => this.fromKline(item, timeframe))
      .sort((a, b) => a.time - b.time);
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    options: MarketRouteOptions = {}
  ): Promise<MarketSubscription> {
    const interval = bybitIntervals[timeframe];
    if (!interval) throw new Error(`Unsupported Bybit timeframe: ${timeframe}`);
    if ((options.priceType ?? "last") !== "last") throw new Error(`Bybit ${options.priceType} websocket candles are not wired yet`);
    const category = bybitCategory(options.marketType);

    const topic = `kline.${interval}.${instrument.symbol}`;
    let closed = false;
    let socket: WebSocket;
    let heartbeat: NodeJS.Timeout | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let attempts = 0;
    let lastTime = 0;

    const backfill = async () => {
      if (lastTime === 0) return;
      try {
        const missed = await this.getCandles(instrument, timeframe, { limit: 1000, startTime: lastTime });
        for (const candle of missed) if (candle.time >= lastTime) onCandle(candle);
      } catch {
        // Non-fatal — live bars resume regardless.
      }
    };

    const connect = () => {
      socket = new WebSocket(`wss://stream.bybit.com/v5/public/${category}`, { maxPayload: 2 * 1024 * 1024 });
      socket.on("open", () => {
        const reconnected = attempts > 0;
        attempts = 0;
        socket.send(JSON.stringify({ op: "subscribe", args: [topic] }));
        onStatus?.(reconnected ? "Bybit websocket reconnected" : "Bybit websocket connected");
        heartbeat = setInterval(() => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ op: "ping" })), 20_000);
        if (reconnected) void backfill();
      });
      socket.on("message", (buffer) => {
        const data = JSON.parse(buffer.toString()) as BybitKlineMessage;
        if (!data.topic || !data.topic.startsWith("kline.") || !data.data) return;
        for (const k of data.data) {
          lastTime = k.start;
          onCandle({
            time: k.start,
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
            final: k.confirm,
            source: this.name
          });
        }
      });
      socket.on("error", (error) => { if (!closed) onStatus?.(`Bybit websocket error: ${error.message}`); });
      socket.on("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        if (closed) return;
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** attempts) + Math.floor(Math.random() * 500);
        onStatus?.(`Bybit websocket closed — reconnecting in ${Math.round(delay / 1000)}s`);
        reconnectTimer = setTimeout(connect, delay);
      });
    };
    connect();

    return {
      close: () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket.close();
      }
    };
  }

  private fromKline(kline: BybitKline, timeframe: Timeframe): Candle {
    return {
      time: Number(kline[0]),
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
      volume: Number(kline[5]),
      final: Number(kline[0]) + timeframeMs[timeframe] <= Date.now(),
      source: this.name
    };
  }
}

function bybitCategory(marketType: MarketRouteOptions["marketType"]): "spot" | "linear" | "inverse" {
  if (marketType === "linear" || marketType === "inverse") return marketType;
  return "spot";
}
