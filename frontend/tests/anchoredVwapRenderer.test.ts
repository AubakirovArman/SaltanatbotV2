import { describe, expect, it, vi } from "vitest";
import { calculateAnchoredVwap } from "../src/chart/anchoredVwap";
import { createDrawing } from "../src/chart/drawings";
import { drawAnchoredVwap } from "../src/chart/renderers/anchoredVwap";
import { buildViewport } from "../src/chart/viewport";

describe("anchored VWAP renderer", () => {
  it("draws a filled first-deviation band, two band pairs and a value label", () => {
    const candles = Array.from({ length: 8 }, (_, index) => ({
      time: index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 10 + index
    }));
    const plot = { left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 };
    const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const drawing = createDrawing("anchored-vwap", [{ time: candles[1].time, price: candles[1].close }]);
    const ctx = recordingContext();

    drawAnchoredVwap(ctx, viewport, drawing, calculateAnchoredVwap(candles, candles[1].time), 2);

    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledTimes(6);
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 3]);
    expect(ctx.setLineDash).toHaveBeenCalledWith([2, 4]);
    expect(ctx.fillText).toHaveBeenCalledWith(expect.stringMatching(/^AVWAP \d+\.\d{2}$/), expect.any(Number), expect.any(Number));
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = {
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn()
  };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & { fill: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; setLineDash: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn> };
}
