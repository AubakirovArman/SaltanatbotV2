import { describe, expect, it, vi } from "vitest";
import { loadCandleHistory, type CandlePageLoader } from "../src/strategy/candleHistory";
import type { Candle } from "../src/types";

const candle = (time: number): Candle => ({ time, open: time, high: time, low: time, close: time, volume: 1 });

describe("paged candle history", () => {
  it("pages backward, removes overlaps and returns chronological target bars", async () => {
    const load = vi.fn<CandlePageLoader>(async (_symbol, _timeframe, _limit, endTime) => ({
      candles: endTime === undefined
        ? [candle(4), candle(5), candle(6)]
        : [candle(2), candle(3), candle(4)]
    }));

    const result = await loadCandleHistory({ symbol: "BTCUSDT", timeframe: "1m", bars: 5 }, load);

    expect(result.map((item) => item.time)).toEqual([2, 3, 4, 5, 6]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[3]).toBe(3);
  });

  it("stops at the requested research boundary", async () => {
    const load = vi.fn<CandlePageLoader>(async () => ({ candles: [candle(10), candle(11)] }));

    const result = await loadCandleHistory({ symbol: "BTCUSDT", timeframe: "1m", bars: 100, stopAt: 10 }, load);

    expect(result.map((item) => item.time)).toEqual([10, 11]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("terminates when a provider returns no strictly older candles", async () => {
    const load = vi.fn<CandlePageLoader>(async () => ({ candles: [candle(5), candle(6)] }));

    await expect(loadCandleHistory({ symbol: "BTCUSDT", timeframe: "1m", bars: 10 }, load)).resolves.toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
