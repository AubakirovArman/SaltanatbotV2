import { describe, expect, it } from "vitest";
import { bollinger } from "../src/chart/indicatorMath";
import type { Candle } from "../src/types";

describe("indicator math allocation bounds", () => {
  it("computes Bollinger bands with a rolling window and no per-point slice", () => {
    const source = Array.from({ length: 12_000 }, (_, index): Candle => {
      const close = 100 + Math.sin(index * 0.13) * 5 + index * 0.001;
      return {
        time: 1_710_000_000_000 + index * 60_000,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100
      };
    });
    const guarded = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "slice") throw new Error("Bollinger must not allocate a window for every point");
        return Reflect.get(target, property, receiver);
      }
    });

    const actual = bollinger(guarded, 20, 2);
    const lastWindow = source.slice(-20).map((candle) => candle.close);
    const mean = lastWindow.reduce((sum, value) => sum + value, 0) / lastWindow.length;
    const variance = lastWindow.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lastWindow.length;
    const expectedBand = Math.sqrt(variance) * 2;

    expect(actual).toHaveLength(source.length);
    expect(actual.at(-1)?.middle).toBeCloseTo(mean, 8);
    expect(actual.at(-1)?.upper).toBeCloseTo(mean + expectedBand, 8);
    expect(actual.at(-1)?.lower).toBeCloseTo(mean - expectedBand, 8);
  });
});
