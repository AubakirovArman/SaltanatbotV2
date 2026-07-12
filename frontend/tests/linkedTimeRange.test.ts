import { describe, expect, it } from "vitest";
import { linkedRangeFromViewport, viewForLinkedRange } from "../src/chart/linkedTimeRange";
import { buildViewport } from "../src/chart/viewport";
import type { Candle } from "../src/types";

const minute = 60_000;
const candles: Candle[] = Array.from({ length: 200 }, (_, index) => ({
  time: index * minute,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 10,
  final: true
}));
const plot = { left: 10, top: 10, width: 800, height: 400, right: 810, bottom: 410 };

describe("linked chart time ranges", () => {
  it("round-trips an absolute range through local zoom and offset", () => {
    const initial = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const range = { sourceId: "primary", startTime: candles[50].time, endTime: candles[149].time };
    const view = viewForLinkedRange(candles, initial, range);
    expect(view).toEqual({ zoom: 1, offset: 50 });
    const linked = buildViewport({ candles, plot, ...view!, priceMode: "linear" });
    expect(linkedRangeFromViewport(linked, "secondary")).toEqual({ ...range, sourceId: "secondary" });
  });

  it("maps the same UTC window to a different timeframe", () => {
    const fiveMinute = candles.filter((_, index) => index % 5 === 0);
    const viewport = buildViewport({ candles: fiveMinute, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const view = viewForLinkedRange(fiveMinute, viewport, { sourceId: "primary", startTime: candles[50].time, endTime: candles[149].time });
    expect(view).toMatchObject({ zoom: 4, offset: 10 });
  });

  it("fails closed when the requested history is not loaded", () => {
    const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    expect(viewForLinkedRange(candles, viewport, { sourceId: "other", startTime: -20 * minute, endTime: -minute })).toBeUndefined();
  });
});
