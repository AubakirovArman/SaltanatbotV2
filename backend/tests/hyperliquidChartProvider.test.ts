import { describe, expect, it, vi } from "vitest";
import { parseHyperliquidBook } from "../src/orderbook/hyperliquid.js";
import { HyperliquidProvider, hyperliquidPerpetualCoin, parseHyperliquidCandle } from "../src/providers/hyperliquid.js";
import { parseHyperliquidTrades } from "../src/tradeflow/hyperliquid.js";

const instrument = {
  symbol: "BTCUSDT",
  displayName: "Bitcoin / Tether",
  assetClass: "crypto" as const,
  exchange: "Binance / Bybit / Hyperliquid",
  currency: "USDT",
  provider: "binance" as const,
  basePrice: 60_000,
  decimals: 2
};

describe("Hyperliquid chart and browser public streams", () => {
  it("requests bounded first-DEX perpetual candles and normalizes ascending OHLCV", async () => {
    const post = vi.fn(async () => [
      candle(120_000, 130_000, "62010", "62020"),
      candle(60_000, 70_000, "62000", "62010")
    ]);
    const provider = new HyperliquidProvider({ post });

    const result = await provider.getCandles(instrument, "1m", { limit: 2, startTime: 60_000, endTime: 180_000 }, { marketType: "linear", priceType: "last" });

    expect(post).toHaveBeenCalledWith({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1m", startTime: 60_000, endTime: 180_000 }
    }, undefined);
    expect(result.map(({ time, open, close, volume, source }) => ({ time, open, close, volume, source }))).toEqual([
      { time: 60_000, open: 62_000, close: 62_010, volume: 12.5, source: "Hyperliquid public" },
      { time: 120_000, open: 62_010, close: 62_020, volume: 12.5, source: "Hyperliquid public" }
    ]);
  });

  it("rejects unsupported chart routes and malformed candle identities", async () => {
    const provider = new HyperliquidProvider({ post: vi.fn(async () => []) });
    await expect(provider.getCandles(instrument, "1m", { limit: 10 }, { marketType: "spot" })).rejects.toThrow(/perpetuals only/);
    expect(() => parseHyperliquidCandle(candle(60_000, 70_000, "1", "2", "ETH"), "BTC", "1m")).toThrow(/identity/);
    expect(hyperliquidPerpetualCoin("ETHUSDT")).toBe("ETH");
  });

  it("normalizes atomic L2 snapshots without fabricating depth", () => {
    const book = parseHyperliquidBook({
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_784_020_000_123,
        levels: [
          [{ px: "62100", sz: "1.25", n: 4 }, { px: "62099", sz: "2.5", n: 7 }],
          [{ px: "62101", sz: "0.75", n: 3 }, { px: "62102", sz: "1.5", n: 5 }]
        ]
      }
    }, "BTC");

    expect(book).toEqual({
      exchangeTs: 1_784_020_000_123,
      bids: [[62100, 1.25], [62099, 2.5]],
      asks: [[62101, 0.75], [62102, 1.5]]
    });
    expect(parseHyperliquidBook({ channel: "l2Book", data: { coin: "BTC", time: 1, levels: [[{ px: "10", sz: "1" }], [{ px: "9", sz: "1" }]] } }, "BTC")).toBeUndefined();
  });

  it("maps the official aggressor side and globally scopes trade ids", () => {
    const trades = parseHyperliquidTrades({
      channel: "trades",
      data: [
        { coin: "BTC", side: "B", px: "62100", sz: "0.1", hash: "0x1", time: 1_784_020_000_123, tid: 11 },
        { coin: "BTC", side: "A", px: "62099", sz: "0.2", hash: "0x2", time: 1_784_020_000_124, tid: 12 }
      ]
    }, "BTC");

    expect(trades).toEqual([
      { id: "1784020000123:BTC:11", price: 62100, size: 0.1, side: "buy", exchangeTs: 1_784_020_000_123 },
      { id: "1784020000124:BTC:12", price: 62099, size: 0.2, side: "sell", exchangeTs: 1_784_020_000_124 }
    ]);
  });
});

function candle(t: number, T: number, o: string, c: string, s = "BTC") {
  return { t, T, s, i: "1m", o, c, h: String(Math.max(Number(o), Number(c)) + 5), l: String(Math.min(Number(o), Number(c)) - 5), v: "12.5", n: 10 };
}
