import WebSocket from "ws";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { binanceIntervals } from "../market/timeframes.js";
import type { CandleRange, MarketProvider, MarketSubscription } from "./provider.js";

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

export class BinanceProvider implements MarketProvider {
  readonly name = "Binance public";

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange) {
    const interval = binanceIntervals[timeframe];
    if (!interval) {
      throw new Error(`Unsupported Binance timeframe: ${timeframe}`);
    }
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", instrument.symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(Math.min(range.limit, 1000)));
    if (range.endTime !== undefined) url.searchParams.set("endTime", String(range.endTime));
    if (range.startTime !== undefined) url.searchParams.set("startTime", String(range.startTime));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}`);
    }
    const payload = (await response.json()) as BinanceKline[];
    return payload.map((item) => this.fromKline(item));
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void
  ): Promise<MarketSubscription> {
    const interval = binanceIntervals[timeframe];
    if (!interval) {
      throw new Error(`Unsupported Binance timeframe: ${timeframe}`);
    }

    const stream = `${instrument.symbol.toLowerCase()}@kline_${interval}`;
    const socket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
    let closed = false;

    socket.on("open", () => onStatus?.("Binance websocket connected"));
    socket.on("message", (buffer) => {
      const data = JSON.parse(buffer.toString()) as BinanceStreamMessage;
      if (data.e !== "kline") return;
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
      if (!closed) {
        onStatus?.(`Binance websocket error: ${error.message}`);
      }
    });
    socket.on("close", () => {
      if (!closed) {
        onStatus?.("Binance websocket closed");
      }
    });

    return {
      close: () => {
        closed = true;
        socket.close();
      }
    };
  }

  private fromKline(kline: BinanceKline): Candle {
    return {
      time: kline[0],
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
      volume: Number(kline[5]),
      final: true,
      source: this.name
    };
  }
}
