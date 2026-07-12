import { describe, expect, it, vi } from "vitest";
import { drawPointAndFigure } from "../src/chart/renderers/pointAndFigure";

describe("Point & Figure renderer", () => {
  it("draws X diagonals and O circles in alternating columns", () => {
    const ctx = context();
    drawPointAndFigure({
      ctx,
      candles: [
        { time: 1, open: 100, high: 102, low: 100, close: 102, volume: 10, direction: "x", boxSize: 1, boxes: 2, reversalBoxes: 3, sourceCount: 2 },
        { time: 2, open: 102, high: 102, low: 99, close: 99, volume: 20, direction: "o", boxSize: 1, boxes: 3, reversalBoxes: 3, sourceCount: 2 }
      ],
      plot: { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 },
      scale: { min: 90, max: 110, mode: "linear", base: 100, y: (price) => 110 - price, priceAt: (y) => 110 - y },
      step: 20,
      decimals: 2,
      theme: { background: "#000", panel: "#111", grid: "#222", text: "#fff", muted: "#888", up: "green", down: "red", accent: "blue", areaFill: "transparent" }
    });
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.arc).toHaveBeenCalledTimes(3);
    expect(ctx.lineTo).toHaveBeenCalledTimes(4);
  });
});

function context() {
  const values: Record<PropertyKey, unknown> = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), stroke: vi.fn() };
  return new Proxy(values, {
    get(target, property) { if (!(property in target)) target[property] = vi.fn(); return target[property]; },
    set(target, property, value) { target[property] = value; return true; }
  }) as unknown as CanvasRenderingContext2D & Record<"stroke" | "arc" | "lineTo", ReturnType<typeof vi.fn>>;
}
