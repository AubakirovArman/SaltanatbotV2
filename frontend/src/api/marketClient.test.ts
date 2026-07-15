// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCandles } from "./marketClient";

afterEach(() => vi.unstubAllGlobals());

describe("chart market route transport", () => {
  it("preserves exchange, market and price types in candle requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      instrument: {
        symbol: "BTCUSDT",
        displayName: "BTC/USDT",
        assetClass: "crypto",
        exchange: "Binance / Bybit",
        currency: "USDT",
        provider: "binance",
        basePrice: 1,
        decimals: 2
      },
      candles: [],
      provider: "Binance",
      hasMore: false
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getCandles("BTCUSDT", "1h", 320, undefined, "binance", { marketType: "linear", priceType: "mark" });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("exchange=binance");
    expect(url).toContain("marketType=linear");
    expect(url).toContain("priceType=mark");
  });
});
