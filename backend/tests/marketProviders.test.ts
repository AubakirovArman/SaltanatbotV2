import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceProvider } from "../src/providers/binance.js";
import { BybitProvider } from "../src/providers/bybit.js";
import { ProviderRouter } from "../src/providers/router.js";
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
});

function json(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
}
