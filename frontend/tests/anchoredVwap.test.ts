import { describe, expect, it } from "vitest";
import { calculateAnchoredVwap } from "../src/chart/anchoredVwap";
import { defaultStyle, TOOL_POINT_COUNT } from "../src/chart/drawings";
import type { Candle } from "../src/types";

describe("anchored VWAP", () => {
  it("calculates cumulative typical-price VWAP and weighted deviation", () => {
    const points = calculateAnchoredVwap([
      candle(0, 98, 102, 100, 1),
      candle(1, 108, 112, 110, 3)
    ], 0);

    expect(points).toHaveLength(2);
    expect(points[1].vwap).toBeCloseTo(107.5, 8);
    expect(points[1].deviation).toBeCloseTo(Math.sqrt(18.75), 8);
    expect(points[1].cumulativeVolume).toBe(4);
  });

  it("starts at the first candle on or after the anchor without look-ahead", () => {
    const candles = [candle(0, 0, 300, 300, 99), candle(1, 108, 112, 110, 3)];
    expect(calculateAnchoredVwap(candles, 1)).toEqual([
      { time: 1, vwap: 110, deviation: 0, cumulativeVolume: 3 }
    ]);
  });

  it("fails closed when the saved anchor predates loaded history", () => {
    expect(calculateAnchoredVwap([candle(10, 98, 102, 100, 1)], 5)).toEqual([]);
  });

  it("skips an empty-volume prefix and never invents weight", () => {
    const points = calculateAnchoredVwap([
      candle(0, 98, 102, 100, 0),
      candle(1, 108, 112, 110, 2),
      candle(2, 118, 122, 120, 0)
    ], 0);
    expect(points.map((point) => point.time)).toEqual([1, 2]);
    expect(points.at(-1)).toMatchObject({ vwap: 110, cumulativeVolume: 2 });
  });

  it("defines a one-click drawing with one and two deviation bands", () => {
    expect(TOOL_POINT_COUNT["anchored-vwap"]).toBe(1);
    expect(defaultStyle("anchored-vwap")).toMatchObject({ color: "#53b7e8", levels: [1, 2] });
  });
});

function candle(time: number, low: number, high: number, close: number, volume: number): Candle {
  return { time, open: close, low, high, close, volume };
}
