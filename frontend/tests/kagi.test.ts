import { describe, expect, it } from "vitest";
import { buildKagi } from "../src/chart/kagi";
import type { Candle } from "../src/types";

describe("confirmed percentage Kagi", () => {
  it("extends price extremes and starts a new leg only after the reversal threshold", () => {
    const legs = buildKagi(series([100, 101, 102, 101.5, 101, 99]), { decimals: 2, reversalPercent: 1 });
    expect(legs.map(({ open, close, direction }) => ({ open, close, direction }))).toEqual([
      { open: 100, close: 102, direction: "up" },
      { open: 102, close: 99, direction: "down" }
    ]);
  });

  it("aggregates source volume and counts without duplication", () => {
    const legs = buildKagi(series([100, 101, 102, 101.5, 100]), { decimals: 2, reversalPercent: 1 });
    expect(legs.map((leg) => leg.sourceCount)).toEqual([4, 1]);
    expect(legs.reduce((sum, leg) => sum + leg.volume, 0)).toBe(50);
  });

  it("uses close-only data and excludes the provisional source tail", () => {
    const candles = series([100, 102, 90]);
    candles[1] = { ...candles[1], high: 1_000, low: 1 };
    candles[2] = { ...candles[2], final: false };
    expect(buildKagi(candles, { decimals: 2, reversalPercent: 1 })).toMatchObject([
      { open: 100, high: 102, low: 100, close: 102, direction: "up" }
    ]);
  });

  it("keeps the seeded reversal size stable as confirmed candles append", () => {
    const initial = buildKagi(series([100, 101, 102]), { decimals: 2 });
    const appended = buildKagi(series([100, 101, 102, 120]), { decimals: 2 });
    expect(initial[0].reversalSize).toBe(0.1);
    expect(new Set(appended.map((leg) => leg.reversalSize))).toEqual(new Set([0.1]));
  });
});

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index * 60_000,
    open: close,
    high: close + 20,
    low: close - 20,
    close,
    volume: 10,
    final: true
  }));
}
