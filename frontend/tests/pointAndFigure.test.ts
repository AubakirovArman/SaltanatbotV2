import { describe, expect, it } from "vitest";
import { buildPointAndFigure } from "../src/chart/pointAndFigure";
import type { Candle } from "../src/types";

describe("confirmed Point & Figure", () => {
  it("builds alternating X/O columns with a multi-box reversal", () => {
    const columns = buildPointAndFigure(series([100, 101, 102, 100, 99, 100, 102]), { decimals: 2, boxPercent: 1, reversalBoxes: 3 });
    expect(columns.map(({ open, close, direction, boxes }) => ({ open, close, direction, boxes }))).toEqual([
      { open: 100, close: 102, direction: "x", boxes: 2 },
      { open: 102, close: 99, direction: "o", boxes: 3 },
      { open: 99, close: 102, direction: "x", boxes: 3 }
    ]);
  });

  it("does not reverse before the configured distance", () => {
    const columns = buildPointAndFigure(series([100, 101, 102, 100]), { decimals: 2, boxPercent: 1, reversalBoxes: 3 });
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ direction: "x", close: 102, sourceCount: 4, volume: 40 });
  });

  it("uses closes only and excludes the provisional tail", () => {
    const candles = series([100, 102, 96]);
    candles[1] = { ...candles[1], high: 1_000, low: 1 };
    candles[2] = { ...candles[2], final: false };
    expect(buildPointAndFigure(candles, { decimals: 2, boxPercent: 1 })).toMatchObject([
      { open: 100, high: 102, low: 100, close: 102, direction: "x", boxes: 2 }
    ]);
  });

  it("keeps the seeded box size stable as confirmed data appends", () => {
    const initial = buildPointAndFigure(series([100, 101, 102]), { decimals: 2 });
    const appended = buildPointAndFigure(series([100, 101, 102, 120]), { decimals: 2 });
    expect(initial[0].boxSize).toBe(0.1);
    expect(new Set(appended.map((column) => column.boxSize))).toEqual(new Set([0.1]));
  });
});

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => ({ time: index * 60_000, open: close, high: close + 20, low: close - 20, close, volume: 10, final: true }));
}
