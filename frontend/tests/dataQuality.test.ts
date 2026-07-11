import { describe, expect, it } from "vitest";
import { analyzeCandleGaps } from "../src/market/dataQuality";

const candle = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

describe("market data quality", () => {
  it("reports missing intervals without treating ordinary bars as gaps", () => {
    expect(analyzeCandleGaps([candle(0), candle(60_000), candle(240_000), candle(300_000)], "1m"))
      .toEqual({ gapCount: 1, missingBars: 2, largestGapMs: 180_000 });
  });
});
