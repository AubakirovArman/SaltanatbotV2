import { describe, expect, it, vi } from "vitest";
import { drawKagi } from "../src/chart/renderers/kagi";

describe("Kagi renderer", () => {
  it("draws vertical legs, horizontal turns and confirmed endpoints", () => {
    const ctx = recordingContext();
    drawKagi({
      ctx,
      candles: [
        { time: 1, open: 100, high: 102, low: 100, close: 102, volume: 10 },
        { time: 2, open: 102, high: 102, low: 99, close: 99, volume: 20 }
      ],
      plot: { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 },
      scale: { min: 90, max: 110, mode: "linear", base: 100, y: (price) => 110 - price, priceAt: (y) => 110 - y },
      step: 20,
      decimals: 2,
      theme: { background: "#000", panel: "#111", grid: "#222", text: "#fff", muted: "#888", up: "green", down: "red", accent: "blue", areaFill: "transparent" }
    });
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.arc).toHaveBeenCalledTimes(2);
    expect(ctx.fill).toHaveBeenCalledTimes(2);
    expect(ctx.lineTo).toHaveBeenCalledTimes(3);
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn()
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
  }) as unknown as CanvasRenderingContext2D & Record<"stroke" | "arc" | "fill" | "lineTo", ReturnType<typeof vi.fn>>;
}
