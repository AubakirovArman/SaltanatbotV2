import { describe, expect, it } from "vitest";
import { buildRenko } from "../src/chart/renko";
import type { Candle } from "../src/types";

describe("confirmed traditional Renko", () => {
  it("uses fixed close-only bricks and a two-brick reversal", () => {
    const bricks = buildRenko(series([100, 101, 102, 101, 100, 99]), { decimals: 2, brickPercent: 1 });
    expect(bricks.map(({ open, close, direction }) => ({ open, close, direction }))).toEqual([
      { open: 100, close: 101, direction: "up" },
      { open: 101, close: 102, direction: "up" },
      { open: 101, close: 100, direction: "down" },
      { open: 100, close: 99, direction: "down" }
    ]);
  });

  it("creates multiple same-time bricks without duplicating source volume", () => {
    const bricks = buildRenko(series([100, 103.4]), { decimals: 2, brickPercent: 1 });
    expect(bricks).toHaveLength(3);
    expect(bricks.map((brick) => brick.time)).toEqual([60_000, 60_000, 60_000]);
    expect(bricks.reduce((sum, brick) => sum + brick.volume, 0)).toBeCloseTo(20);
    expect(bricks.map((brick) => brick.sourceCount)).toEqual([2, 0, 0]);
  });

  it("draws only adverse wicks backed by discarded close extremes", () => {
    const up = buildRenko(series([100, 101, 100.4, 102]), { decimals: 2, brickPercent: 1 });
    expect(up.at(-1)).toMatchObject({ open: 101, close: 102, high: 102, low: 100.4 });
    const down = buildRenko(series([100, 99, 99.6, 98]), { decimals: 2, brickPercent: 1 });
    expect(down.at(-1)).toMatchObject({ open: 99, close: 98, high: 99.6, low: 98 });
  });

  it("ignores source High/Low and the provisional tail", () => {
    const candles = series([100, 101, 110]);
    candles[1] = { ...candles[1], high: 1_000, low: 1 };
    candles[2] = { ...candles[2], final: false };
    const bricks = buildRenko(candles, { decimals: 2, brickPercent: 1 });
    expect(bricks).toHaveLength(1);
    expect(bricks[0]).toMatchObject({ open: 100, close: 101, high: 101, low: 100 });
  });

  it("keeps the seeded brick size stable as closed candles append", () => {
    const initial = buildRenko(series([100, 101, 102]), { decimals: 2 });
    const appended = buildRenko(series([100, 101, 102, 120]), { decimals: 2 });
    expect(initial[0].brickSize).toBe(0.05);
    expect(new Set(appended.map((brick) => brick.brickSize))).toEqual(new Set([0.05]));
  });
});

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => ({ time: index * 60_000, open: close, high: close + 5, low: close - 5, close, volume: 10, final: true }));
}
