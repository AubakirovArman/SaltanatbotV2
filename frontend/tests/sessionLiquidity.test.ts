import { describe, expect, it } from "vitest";
import { analyzeSessionLiquidity, utcDayStart } from "../src/chart/sessionLiquidity";
import type { Candle } from "../src/types";

const day = Date.UTC(2026, 6, 12);

describe("UTC session liquidity analysis", () => {
  it("aligns timestamps to an exchange-compatible UTC day", () => {
    expect(utcDayStart(Date.UTC(2026, 6, 12, 23, 59, 59))).toBe(day);
  });

  it("computes volume-weighted typical-price VWAP and deviation bands", () => {
    const snapshot = analyzeSessionLiquidity([
      candle(day, 100, 102, 98, 100, 1),
      candle(day + 60_000, 108, 112, 108, 110, 3, true)
    ], []);

    expect(snapshot?.open).toBe(100);
    expect(snapshot?.high).toBe(112);
    expect(snapshot?.low).toBe(98);
    expect(snapshot?.vwap).toBeCloseTo(107.5, 8);
    expect(snapshot?.upperBand).toBeCloseTo(111.830127, 5);
    expect(snapshot?.lowerBand).toBeCloseTo(103.169873, 5);
  });

  it("uses the latest prior daily candle and confirms wick-and-reclaim sweeps", () => {
    const snapshot = analyzeSessionLiquidity([
      candle(day, 100, 114, 99, 111, 2),
      candle(day + 60_000, 100, 101, 89, 91, 2),
      candle(day + 120_000, 100, 118, 88, 100, 2)
    ], [
      candle(day - 2 * 86_400_000, 90, 110, 80, 100, 10, true),
      candle(day - 86_400_000, 100, 112, 90, 105, 10, true)
    ]);

    expect(snapshot?.previousDayHigh).toBe(112);
    expect(snapshot?.previousDayLow).toBe(90);
    expect(snapshot?.sweeps).toEqual([
      { time: day, price: 114, side: "high" },
      { time: day + 60_000, price: 89, side: "low" }
    ]);
  });

  it("does not invent VWAP or confirmed sweeps from zero-volume or live-tail bars", () => {
    const snapshot = analyzeSessionLiquidity([
      candle(day, 100, 120, 80, 100, 0)
    ], [candle(day - 86_400_000, 100, 110, 90, 100, 10, true)]);

    expect(snapshot?.vwap).toBeUndefined();
    expect(snapshot?.upperBand).toBeUndefined();
    expect(snapshot?.sweeps).toEqual([]);
  });
});

function candle(time: number, open: number, high: number, low: number, close: number, volume: number, final?: boolean): Candle {
  return { time, open, high, low, close, volume, final };
}
