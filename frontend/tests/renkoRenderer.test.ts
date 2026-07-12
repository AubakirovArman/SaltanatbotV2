import { describe, expect, it, vi } from "vitest";
import { drawRenko } from "../src/chart/renderers/renko";

describe("Renko renderer", () => {
  it("draws synthetic bodies and actual-close wicks", () => {
    const ctx = recordingContext();
    drawRenko({
      ctx,
      candles: [{ time: 1, open: 100, high: 101, low: 99.4, close: 101, volume: 10 }],
      plot: { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 },
      scale: { min: 90, max: 110, mode: "linear", base: 100, y: (price) => 110 - price, priceAt: (y) => 110 - y },
      step: 20,
      decimals: 2,
      theme: { background: "#000", panel: "#111", grid: "#222", text: "#fff", muted: "#888", up: "green", down: "red", accent: "blue", areaFill: "transparent" }
    });
    expect(ctx.beginPath).toHaveBeenCalledTimes(1);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = { beginPath: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"beginPath" | "stroke" | "fillRect" | "strokeRect", ReturnType<typeof vi.fn>>;
}
