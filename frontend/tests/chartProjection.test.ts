import { describe, expect, it } from "vitest";
import { visibleCandles } from "../src/chart/scales";
import { buildViewport, medianBarTime } from "../src/chart/viewport";
import type { Candle } from "../src/types";

const candles: Candle[] = Array.from({ length: 100 }, (_, index) => ({
  time: index * 60_000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1
}));
const plot = { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 };

describe("future projection viewport", () => {
  it("reserves right-side space without dropping below the minimum candle window", () => {
    const regular = visibleCandles(candles, plot, 1, 0);
    const projected = visibleCandles(candles, plot, 1, 0, 20);

    expect(projected.data.length).toBeLessThan(regular.data.length);
    expect(projected.data.length).toBeGreaterThanOrEqual(24);
    expect(projected.data.at(-1)?.time).toBe(candles.at(-1)?.time);
  });

  it("extrapolates future timestamps onto the reserved chart area", () => {
    const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear", rightPaddingBars: 10 });
    const future = candles.at(-1)!.time + 10 * 60_000;

    expect(medianBarTime(candles)).toBe(60_000);
    expect(viewport.timeToX(future)).toBeGreaterThan(viewport.timeToX(candles.at(-1)!.time));
    expect(viewport.xToTime(viewport.timeToX(future))).toBeCloseTo(future);
  });
});
