import { describe, expect, it } from "vitest";
import {
  parseCandlesResponse,
  parseCatalogResponse,
  parseSparklinesResponse,
  parseStreamMessage,
} from "@saltanatbotv2/contracts";

const instrument = {
  symbol: "BTCUSDT",
  displayName: "Bitcoin / Tether",
  assetClass: "crypto",
  exchange: "BINANCE",
  currency: "USDT",
  provider: "binance",
  basePrice: 100_000,
  decimals: 2,
} as const;
const candle = { time: 60_000, open: 100, high: 102, low: 99, close: 101, volume: 10, source: "binance" };

describe("runtime market contracts", () => {
  it("validates catalog and candle REST responses", () => {
    expect(parseCatalogResponse({
      instruments: [instrument],
      timeframes: ["1m", "1h"],
      chartTypes: ["candles", "line"],
    }).instruments[0]).toEqual(instrument);
    expect(parseCandlesResponse({ instrument, candles: [candle], provider: "binance", hasMore: true })).toMatchObject({
      candles: [candle],
      provider: "binance",
      hasMore: true,
    });
  });

  it("validates nullable sparkline entries and finite points", () => {
    expect(parseSparklinesResponse({
      timeframe: "5m",
      series: { BTCUSDT: { last: 101, changePct: 1, points: [100, 101] }, ETHUSDT: null },
    })).toEqual({
      timeframe: "5m",
      series: { BTCUSDT: { last: 101, changePct: 1, points: [100, 101] }, ETHUSDT: null },
    });
  });

  it("validates every public market WebSocket variant", () => {
    expect(parseStreamMessage({ type: "snapshot", symbol: "BTCUSDT", timeframe: "1m", candles: [candle], provider: "binance", ts: 1 }).type).toBe("snapshot");
    expect(parseStreamMessage({ type: "candle", symbol: "BTCUSDT", timeframe: "1m", candle, provider: "binance", ts: 2 }).type).toBe("candle");
    expect(parseStreamMessage({ type: "status", status: "fallback", provider: "synthetic", message: "Fallback", ts: 3 }).type).toBe("status");
    expect(parseStreamMessage({ type: "error", message: "Unavailable", ts: 4 })).toEqual({
      type: "error",
      message: "Unavailable",
      ts: 4,
    });
  });

  it("rejects unknown variants, inconsistent OHLC and unsupported enums", () => {
    expect(() => parseStreamMessage({ type: "trade", ts: 1 })).toThrow(/Unsupported stream message type/);
    expect(() => parseStreamMessage({
      type: "candle",
      symbol: "BTCUSDT",
      timeframe: "2s",
      candle,
      provider: "binance",
      ts: 1,
    })).toThrow(/timeframe is unsupported/);
    expect(() => parseCandlesResponse({
      instrument,
      candles: [{ ...candle, high: 90 }],
      provider: "binance",
    })).toThrow(/OHLC range is inconsistent/);
  });
});
