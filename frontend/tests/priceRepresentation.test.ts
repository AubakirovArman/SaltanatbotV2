import { describe, expect, it } from "vitest";
import { toHeikinAshi } from "../src/chart/heikinAshi";
import { preparePriceCandles } from "../src/chart/priceRepresentation";
import type { Candle } from "../src/types";

const candles: Candle[] = Array.from({ length: 8 }, (_, index) => ({
  time: index * 60_000, open: 100 + index, high: 104 + index, low: 98 + index, close: 102 + index, volume: 10, final: true
}));

describe("price representation preparation", () => {
  it("computes Heikin Ashi over full history before any visible slice", () => {
    const prepared = preparePriceCandles(candles, "heikin", 2);
    expect(prepared).toEqual(toHeikinAshi(candles));
    expect(prepared.slice(-3)).not.toEqual(toHeikinAshi(candles.slice(-3)));
  });

  it("keeps ordinary price types on the original zero-copy series", () => {
    expect(preparePriceCandles(candles, "candles", 2)).toBe(candles);
    expect(preparePriceCandles(candles, "line", 2)).toBe(candles);
  });

  it("routes price-compressed types through confirmed transformations", () => {
    expect(preparePriceCandles(candles, "renko", 2).length).toBeGreaterThan(0);
    expect(preparePriceCandles(candles, "linebreak", 2).length).toBeGreaterThan(0);
    expect(preparePriceCandles(candles, "kagi", 2).length).toBeGreaterThan(0);
  });

  it("routes explicit construction settings into every price-compressed transform", () => {
    const settings = { renkoBrickPercent: 1, lineBreakDepth: 5, kagiReversalPercent: 1 };
    expect(preparePriceCandles(candles, "renko", 2, settings).length).toBeLessThan(preparePriceCandles(candles, "renko", 2).length);
    expect(preparePriceCandles(candles, "kagi", 2, settings).every((leg) => leg.high >= leg.low)).toBe(true);
    expect(preparePriceCandles(candles, "linebreak", 2, settings).length).toBeGreaterThan(0);
  });
});
