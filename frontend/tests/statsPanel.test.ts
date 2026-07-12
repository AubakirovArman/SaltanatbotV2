import { describe, expect, it } from "vitest";
import { sessionRange } from "../src/components/StatsPanel";

describe("StatsPanel session range", () => {
  it("uses the trailing 24-hour high/low and clamps the last-price position", () => {
    const hour = 3_600_000;
    const candles = [
      { time: 0, open: 5, high: 50, low: 1, close: 5, volume: 1 },
      { time: 25 * hour, open: 100, high: 120, low: 80, close: 100, volume: 1 },
      { time: 26 * hour, open: 100, high: 130, low: 90, close: 125, volume: 1 }
    ];
    expect(sessionRange(candles)).toEqual({ low: 80, high: 130, position: 90 });
  });
});
