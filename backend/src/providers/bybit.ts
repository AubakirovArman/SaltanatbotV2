import WebSocket from "ws";
import type { Candle, Instrument, Timeframe } from "../types.js";
import { bybitIntervals } from "../market/timeframes.js";
import type { CandleRange, MarketProvider, MarketSubscription } from "./provider.js";

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

/** Public Bybit v5 spot market data (klines REST + WS). No API keys needed. */
export class BybitProvider implements MarketProvider {
  readonly name = "Bybit public";

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange) {
    const interval = bybitIntervals[timeframe];
    if (!interval) throw new Error(`Unsupported Bybit timeframe: ${timeframe}`);
    const url = new URL("https://api.bybit.com/v5/market/kline");
    url.searchParams.set("category", "spot");
    url.searchParams.set("symbol", instrument.symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(Math.min(range.limit, 1000)));
    if (range.endTime !== undefined) url.searchParams.set("end", String(range.endTime));
    if (range.startTime !== undefined) url.searchParams.set("start", String(range.startTime));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
    const payload = (await response.json()) as { retCode: number; retMsg: string; result?: { list?: BybitKline[] } };
    if (payload.retCode !== 0) throw new Error(`Bybit: ${payload.retMsg}`);
    const list = payload.result?.list ?? [];
    // Bybit returns newest-first; reverse to ascending time.
    return list
      .map((item) => this.fromKline(item))
      .sort((a, b) => a.time - b.time);
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void
  ): Promise<MarketSubscription> {
    const interval = bybitIntervals[timeframe];
    if (!interval) throw new Error(`Unsupported Bybit timeframe: ${timeframe}`);

    const socket = new WebSocket("wss://stream.bybit.com/v5/public/spot");
    const topic = `kline.${interval}.${instrument.symbol}`;
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;

    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "subscribe", args: [topic] }));
      onStatus?.("Bybit websocket connected");
      heartbeat = setInterval(() => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ op: "ping" })), 20_000);
    });
    socket.on("message", (buffer) => {
      const data = JSON.parse(buffer.toString()) as BybitKlineMessage;
      if (!data.topic || !data.topic.startsWith("kline.") || !data.data) return;
      for (const k of data.data) {
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
    socket.on("close", () => { if (!closed) onStatus?.("Bybit websocket closed"); });

    return {
      close: () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        socket.close();
      }
    };
  }

  private fromKline(kline: BybitKline): Candle {
    return {
      time: Number(kline[0]),
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
