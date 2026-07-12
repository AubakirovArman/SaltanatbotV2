import { describe, expect, it } from "vitest";
import { buildLineBreak } from "../src/chart/lineBreak";
import type { Candle } from "../src/types";

describe("Three Line Break transformation", () => {
  it("extends only close extremes and compresses unchanged source bars", () => {
    const lines = buildLineBreak(series([100, 101, 102, 101.5, 103]));
    expect(lines.map(({ open, close, direction, sourceCount }) => ({ open, close, direction, sourceCount }))).toEqual([
      { open: 100, close: 101, direction: "up", sourceCount: 2 },
      { open: 101, close: 102, direction: "up", sourceCount: 1 },
      { open: 102, close: 103, direction: "up", sourceCount: 2 }
    ]);
    expect(lines.map((line) => line.volume)).toEqual([20, 10, 20]);
  });

  it("requires a strict break of the latest three-line range to reverse", () => {
    const noReversal = buildLineBreak(series([100, 101, 102, 103, 100]));
    expect(noReversal).toHaveLength(3);

    const reversed = buildLineBreak(series([100, 101, 102, 103, 99]));
    expect(reversed.at(-1)).toMatchObject({ open: 103, close: 99, low: 99, high: 103, direction: "down" });
  });

  it("applies the same rule to bullish reversals", () => {
    const lines = buildLineBreak(series([103, 102, 101, 100, 104]));
    expect(lines.at(-1)).toMatchObject({ open: 100, close: 104, direction: "up" });
  });

  it("ignores source wicks and the provisional live tail", () => {
    const candles = series([100, 101, 102, 103]);
    candles[3] = { ...candles[3], high: 150, low: 50, close: 99, final: false };
    const lines = buildLineBreak(candles);
    expect(lines.map((line) => line.close)).toEqual([101, 102]);
  });

  it("clamps custom reversal depth to a safe deterministic range", () => {
    expect(buildLineBreak(series([100, 101, 99]), 0).at(-1)?.direction).toBe("down");
    expect(buildLineBreak(series([100, 101, 102, 103, 99]), 100)).toHaveLength(4);
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
