import WebSocket from "ws";
import { readBoundedText } from "../http/boundedResponse.js";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { binanceIntervals, timeframeMs } from "../market/timeframes.js";
import { fetchWithRetry } from "./http.js";
import type { CandleRange, MarketProvider, MarketRouteOptions, MarketSubscription } from "./provider.js";

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

interface BinanceStreamMessage {
  e: "kline";
  s: string;
  k: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean;
  };
}

const MAX_CANDLE_PAYLOAD_BYTES = 4 * 1024 * 1024;

export class BinanceProvider implements MarketProvider {
  readonly name = "Binance public";

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, options: MarketRouteOptions = {}) {
    const interval = binanceIntervals[timeframe];
    if (!interval) {
      throw new Error(`Unsupported Binance timeframe: ${timeframe}`);
    }
    const marketType = options.marketType ?? "spot";
    const priceType = options.priceType ?? "last";
    if (marketType === "spot" && priceType !== "last") {
      throw new Error(`Binance ${priceType} candles require a futures market type`);
    }
    const url = new URL(binanceKlineUrl(marketType, priceType));
    url.searchParams.set("symbol", instrument.symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(Math.min(range.limit, 1000)));
    if (range.endTime !== undefined) url.searchParams.set("endTime", String(range.endTime));
    if (range.startTime !== undefined) url.searchParams.set("startTime", String(range.startTime));

    const response = await fetchWithRetry(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}`);
    }
    const body = await readBoundedText(response, MAX_CANDLE_PAYLOAD_BYTES, () => new Error("Binance candle response is too large"));
    const payload = JSON.parse(body) as BinanceKline[];
    return payload.map((item) => this.fromKline(item, timeframe));
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    options: MarketRouteOptions = {}
  ): Promise<MarketSubscription> {
    const interval = binanceIntervals[timeframe];
    if (!interval) {
      throw new Error(`Unsupported Binance timeframe: ${timeframe}`);
    }
    const marketType = options.marketType ?? "spot";
    const priceType = options.priceType ?? "last";
    if (priceType !== "last") {
      throw new Error(`Binance ${priceType} websocket candles are not wired yet`);
    }

    const url = `${binanceWsBase(marketType)}/${instrument.symbol.toLowerCase()}@kline_${interval}`;
    let closed = false;
    let socket: WebSocket;
    let attempts = 0;
    let lastTime = 0;
    let reconnectTimer: NodeJS.Timeout | undefined;

    // On reconnect, pull any bars that closed while we were disconnected so the
    // consumer's buffer has no gap (critical for stop/target detection).
    const backfill = async () => {
      if (lastTime === 0) return;
      try {
        const missed = await this.getCandles(instrument, timeframe, { limit: 1000, startTime: lastTime });
        for (const candle of missed) if (candle.time >= lastTime) onCandle(candle);
      } catch {
        // A failed backfill is non-fatal — live bars will resume regardless.
      }
    };

    const connect = () => {
      socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });
      socket.on("open", () => {
        const reconnected = attempts > 0;
        attempts = 0;
        onStatus?.(reconnected ? "Binance websocket reconnected" : "Binance websocket connected");
        if (reconnected) void backfill();
      });
      socket.on("message", (buffer) => {
        const data = JSON.parse(buffer.toString()) as BinanceStreamMessage;
        if (data.e !== "kline") return;
        lastTime = data.k.t;
        onCandle({
          time: data.k.t,
          open: Number(data.k.o),
          high: Number(data.k.h),
          low: Number(data.k.l),
          close: Number(data.k.c),
          volume: Number(data.k.v),
          final: data.k.x,
          source: this.name
        });
      });
      socket.on("error", (error) => {
        if (!closed) onStatus?.(`Binance websocket error: ${error.message}`);
      });
      socket.on("close", () => {
        if (closed) return;
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** attempts) + Math.floor(Math.random() * 500);
        onStatus?.(`Binance websocket closed — reconnecting in ${Math.round(delay / 1000)}s`);
        reconnectTimer = setTimeout(connect, delay);
      });
    };
    connect();

    return {
      close: () => {
        closed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket.close();
      }
    };
  }

  private fromKline(kline: BinanceKline, timeframe: Timeframe): Candle {
    return {
      time: kline[0],
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
      volume: Number(kline[5]),
      final: kline[0] + timeframeMs[timeframe] <= Date.now(),
      source: this.name
    };
  }
}

function binanceKlineUrl(marketType: MarketRouteOptions["marketType"], priceType: MarketRouteOptions["priceType"]): string {
  if (marketType === "linear") {
    if (priceType === "mark") return "https://fapi.binance.com/fapi/v1/markPriceKlines";
    if (priceType === "index") return "https://fapi.binance.com/fapi/v1/indexPriceKlines";
    return "https://fapi.binance.com/fapi/v1/klines";
  }
  if (marketType === "inverse") {
    if (priceType === "mark") return "https://dapi.binance.com/dapi/v1/markPriceKlines";
    if (priceType === "index") return "https://dapi.binance.com/dapi/v1/indexPriceKlines";
    return "https://dapi.binance.com/dapi/v1/klines";
  }
  return "https://api.binance.com/api/v3/klines";
}

function binanceWsBase(marketType: MarketRouteOptions["marketType"]): string {
  if (marketType === "linear") return "wss://fstream.binance.com/ws";
  if (marketType === "inverse") return "wss://dstream.binance.com/ws";
  return "wss://stream.binance.com:9443/ws";
}
