import { describe, expect, it, vi } from "vitest";
import { drawLineBreak } from "../src/chart/renderers/lineBreak";

describe("Three Line Break renderer", () => {
  it("draws body-only rising and falling lines without invented wicks", () => {
    const ctx = recordingContext();
    drawLineBreak({
      ctx,
      candles: [
        { time: 1, open: 100, high: 102, low: 100, close: 102, volume: 10 },
        { time: 2, open: 102, high: 102, low: 98, close: 98, volume: 20 }
      ],
      plot: { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 },
      scale: { min: 90, max: 110, mode: "linear", base: 100, y: (price) => 110 - price, priceAt: (y) => 110 - y },
      step: 20,
      decimals: 2,
      theme: { background: "#000", panel: "#111", grid: "#222", text: "#fff", muted: "#888", up: "green", down: "red", accent: "blue", areaFill: "transparent" }
    });
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(2);
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = { fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"fillRect" | "strokeRect" | "beginPath", ReturnType<typeof vi.fn>>;
}
