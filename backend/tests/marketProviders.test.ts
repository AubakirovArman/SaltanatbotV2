import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDynamicCrypto } from "../src/market/dynamicCrypto.js";
import { BinanceProvider } from "../src/providers/binance.js";
import { BybitProvider } from "../src/providers/bybit.js";
import { ProviderRouter } from "../src/providers/router.js";
import { SyntheticProvider } from "../src/providers/synthetic.js";
import type { Instrument } from "../src/types.js";

vi.mock("../src/providers/candleStore.js", () => ({
  readCandles: () => [],
  saveCandles: () => {},
  storedRange: () => undefined
}));

const instrument: Instrument = {
  symbol: "BTCUSDT",
  displayName: "BTCUSDT",
  assetClass: "crypto",
  exchange: "Binance",
  currency: "USDT",
  provider: "binance",
  basePrice: 100,
  decimals: 2
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("REST market providers", () => {
  it("marks the current Binance REST kline as non-final", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(119_999));
    vi.stubGlobal("fetch", async () => json([
      [0, "100", "101", "99", "100", "10", 59_999, "0", 0, "0", "0", "0"],
      [60_000, "100", "102", "98", "101", "11", 119_999, "0", 0, "0", "0", "0"]
    ]));

    const candles = await new BinanceProvider().getCandles(instrument, "1m", { limit: 2 });

    expect(candles.map((candle) => candle.final)).toEqual([true, false]);
  });

  it("marks the current Bybit REST kline as non-final", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(119_999));
    vi.stubGlobal("fetch", async () => json({
      retCode: 0,
      retMsg: "OK",
      result: {
        // Bybit returns newest-first; provider sorts ascending before returning.
        list: [
          ["60000", "100", "102", "98", "101", "11", "0"],
          ["0", "100", "101", "99", "100", "10", "0"]
        ]
      }
    }));

    const candles = await new BybitProvider().getCandles(instrument, "1m", { limit: 2 });

    expect(candles.map((candle) => candle.final)).toEqual([true, false]);
  });
});

describe("dynamic crypto discovery", () => {
  it("seeds every discovered instrument with a positive exchange price", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("exchangeInfo")) {
        return json({
          symbols: [
            { symbol: "AAAUSDT", status: "TRADING", baseAsset: "AAA", quoteAsset: "USDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01000000" }] },
            { symbol: "NOPRICEUSDT", status: "TRADING", baseAsset: "NOPRICE", quoteAsset: "USDT" }
          ]
        });
      }
      if (url.includes("instruments-info")) {
        return json({
          retCode: 0,
          result: { list: [
            { symbol: "AAAUSDT", status: "Trading", baseCoin: "AAA", quoteCoin: "USDT" },
            { symbol: "NOPRICEUSDT", status: "Trading", baseCoin: "NOPRICE", quoteCoin: "USDT" }
          ] }
        });
      }
      if (url.includes("ticker/price")) {
        return json([{ symbol: "AAAUSDT", price: "12.34" }]);
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const discovered = await fetchDynamicCrypto();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ symbol: "AAAUSDT", basePrice: 12.34, decimals: 2 });
  });

  it("keeps the curated catalog when ticker seeds are unavailable", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("exchangeInfo")) {
        return json({ symbols: [{ symbol: "AAAUSDT", status: "TRADING", baseAsset: "AAA", quoteAsset: "USDT" }] });
      }
      if (url.includes("instruments-info")) return json({ retCode: 0, result: { list: [] } });
      if (url.includes("ticker/price")) return json([]);
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(fetchDynamicCrypto()).resolves.toEqual([]);
  });
});

describe("synthetic fallback safety", () => {
  const unseeded = { ...instrument, symbol: "NEWUSDT", basePrice: 0 };

  it("rejects history and streams without a positive reference price", async () => {
    const synthetic = new SyntheticProvider();

    await expect(synthetic.getCandles(unseeded, "1m", { limit: 10 })).rejects.toThrow(/no positive reference price/i);
    await expect(synthetic.subscribe(unseeded, "1m", () => {})).rejects.toThrow(/no positive reference price/i);
  });

  it("returns an explicit unavailable error instead of zero fallback candles", async () => {
    const failing = {
      async getCandles() { throw new Error("exchange offline"); },
      async subscribe() { throw new Error("stream offline"); }
    };
    const router = new ProviderRouter() as unknown as {
      binance: typeof failing;
      getCandles: ProviderRouter["getCandles"];
      subscribe: ProviderRouter["subscribe"];
    };
    router.binance = failing;

    await expect(router.getCandles(unseeded, "1m", { limit: 10 })).rejects.toThrow(/Market data unavailable.*no positive reference price/i);
    await expect(router.subscribe(unseeded, "1m", () => {})).rejects.toThrow(/Market stream unavailable.*no positive reference price/i);
  });

  it("never serves a cached synthetic fallback to a later strict request", async () => {
    const failing = {
      async getCandles() { throw new Error("exchange offline"); },
      async subscribe() { throw new Error("stream offline"); }
    };
    const router = new ProviderRouter() as unknown as {
      binance: typeof failing;
      getCandles: ProviderRouter["getCandles"];
    };
    router.binance = failing;
    const route = { exchange: "binance", marketType: "spot", priceType: "last" } as const;

    await expect(router.getCandles(instrument, "1m", { limit: 10 }, route)).resolves.toHaveLength(10);
    await expect(router.getCandles(instrument, "1m", { limit: 10 }, { ...route, strict: true })).rejects.toThrow("exchange offline");
  });

  it("never shares a synthetic fallback stream with a later strict subscriber", async () => {
    const failing = {
      async getCandles() { throw new Error("exchange offline"); },
      async subscribe() { throw new Error("stream offline"); }
    };
    const router = new ProviderRouter() as unknown as {
      binance: typeof failing;
      subscribe: ProviderRouter["subscribe"];
    };
    router.binance = failing;
    const route = { exchange: "binance", marketType: "spot", priceType: "last" } as const;

    const fallback = await router.subscribe(instrument, "1m", () => {}, undefined, route);
    await expect(router.subscribe(instrument, "1m", () => {}, undefined, { ...route, strict: true })).rejects.toThrow("stream offline");
    fallback.close();
  });
});

describe("ProviderRouter stream fan-out", () => {
  it("shares one upstream subscription per market key", async () => {
    let subscribeCount = 0;
    let closeCount = 0;
    let push: ((value: unknown) => void) | undefined;
    const fake = {
      async getCandles() {
        return [];
      },
      async subscribe(_instrument: unknown, _timeframe: unknown, onCandle: (value: unknown) => void) {
        subscribeCount += 1;
        push = onCandle;
        return { close: () => { closeCount += 1; } };
      }
    };
    const router = new ProviderRouter() as unknown as { binance: typeof fake; subscribe: ProviderRouter["subscribe"] };
    router.binance = fake;
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const subA = await router.subscribe(instrument, "1m", (value) => seenA.push(value), undefined, { exchange: "binance", marketType: "spot", priceType: "last" });
    const subB = await router.subscribe(instrument, "1m", (value) => seenB.push(value), undefined, { exchange: "binance", marketType: "spot", priceType: "last" });
    push?.({ time: 1, close: 100 });

    expect(subscribeCount).toBe(1);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    subA.close();
    expect(closeCount).toBe(0);
    subB.close();
    expect(closeCount).toBe(1);
  });

  it("envelopes every execution candle with a complete immutable market key", async () => {
    let push: ((value: unknown) => void) | undefined;
    const fake = {
      async getCandles() { return []; },
      async subscribe(_instrument: unknown, _timeframe: unknown, onCandle: (value: unknown) => void) {
        push = onCandle;
        return { close() {} };
      }
    };
    const router = new ProviderRouter() as unknown as { binance: typeof fake; subscribeMarket: ProviderRouter["subscribeMarket"] };
    router.binance = fake;
    const seen: unknown[] = [];
    await router.subscribeMarket(instrument, "1m", (event) => seen.push(event), undefined, {
      exchange: "binance", marketType: "linear", priceType: "mark", strict: true,
    });
    push?.({ time: 1, close: 100 });

    expect(seen).toEqual([{
      marketKey: { venue: "binance", marketType: "linear", symbol: "BTCUSDT", timeframe: "1m", priceType: "mark" },
      candle: { time: 1, close: 100 },
    }]);
  });
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
