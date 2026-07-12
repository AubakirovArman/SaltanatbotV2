import { describe, expect, it, vi } from "vitest";
import { formatMeasurementDuration, measureAnchors, signed } from "../src/chart/measurement";
import { drawMeasurement } from "../src/chart/renderers/measurement";
import type { Viewport } from "../src/chart/types";

const viewport = {
  plot: { left: 10, top: 10, width: 180, height: 80, right: 190, bottom: 90 },
  barSpacing: 10,
  timeToX: (time: number) => time / 1_000,
  priceToY: (price: number) => 200 - price
} as Viewport;

describe("chart measurement", () => {
  it("calculates signed price, percent, bars and exact elapsed time", () => {
    expect(measureAnchors({ time: 10_000, price: 100 }, { time: 40_000, price: 110 }, viewport)).toEqual({
      priceDelta: 10,
      percentDelta: 10,
      bars: 3,
      durationMs: 30_000
    });
    expect(signed(-2.5, 2)).toBe("-2.50");
  });

  it("formats durations without empty units", () => {
    expect(formatMeasurementDuration(0)).toBe("0s");
    expect(formatMeasurementDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatMeasurementDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("renders a bounded two-line badge and directional range", () => {
    const ctx = context();
    drawMeasurement(ctx, viewport, [{ x: 20, y: 80 }, { x: 188, y: 12 }], {
      id: "measure", tool: "measure", points: [{ time: 10_000, price: 100 }, { time: 40_000, price: 110 }],
      style: { color: "#fff", width: 1 }
    }, 2);
    expect(ctx.fillText).toHaveBeenNthCalledWith(1, "+10.00 (+10.00%)", expect.any(Number), expect.any(Number));
    expect(ctx.fillText).toHaveBeenNthCalledWith(2, "3 bars · 30s", expect.any(Number), expect.any(Number));
    const badge = ctx.fillRect.mock.calls.at(-1) as number[];
    expect(badge[0] + badge[2]).toBeLessThanOrEqual(viewport.plot.right - 4);
  });
});

function context() {
  const values: Record<PropertyKey, unknown> = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 6 }))
  };
  return new Proxy(values, {
    get(target, property) { if (!(property in target)) target[property] = vi.fn(); return target[property]; },
    set(target, property, value) { target[property] = value; return true; }
  }) as unknown as CanvasRenderingContext2D & Record<"fillRect" | "fillText", ReturnType<typeof vi.fn>>;
}
