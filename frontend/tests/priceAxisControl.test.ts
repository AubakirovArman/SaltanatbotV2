import { describe, expect, it } from "vitest";
import { priceScale, zoomPriceBounds } from "../src/chart/scales";
import { priceZoomFromDrag, priceZoomFromKey, priceZoomFromWheel } from "../src/components/chartCanvas/PriceAxisControl";

describe("manual price-axis scale", () => {
  it("zooms symmetric linear bounds without moving their center", () => {
    expect(zoomPriceBounds(0, 100, 2)).toEqual([25, 75]);
    expect(zoomPriceBounds(0, 100, 0.5)).toEqual([-50, 150]);
    expect(zoomPriceBounds(0, 100, Number.NaN)).toEqual([0, 100]);
  });

  it("applies the factor in logarithmic space", () => {
    const candles = [{ time: 1, open: 100, high: 200, low: 100, close: 150, volume: 1 }];
    const plot = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
    const auto = priceScale(plot, candles, [], "log", 100, 1);
    const zoomed = priceScale(plot, candles, [], "log", 100, 2);
    expect(Math.log(zoomed.max / zoomed.min)).toBeCloseTo(Math.log(auto.max / auto.min) / 2);
  });

  it("normalizes wheel, drag and keyboard gestures to safe bounds", () => {
    expect(priceZoomFromWheel(1, -100)).toBeGreaterThan(1);
    expect(priceZoomFromDrag(1, 80)).toBeGreaterThan(1.7);
    expect(priceZoomFromKey(1, "ArrowUp")).toBe(1.1);
    expect(priceZoomFromKey(2, "Home")).toBe(1);
    expect(priceZoomFromKey(1, "Escape")).toBeUndefined();
    expect(priceZoomFromWheel(4, -10_000)).toBe(4);
  });
});
