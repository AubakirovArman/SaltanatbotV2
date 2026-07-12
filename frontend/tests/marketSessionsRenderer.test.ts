import { describe, expect, it, vi } from "vitest";
import { drawMarketSessions } from "../src/chart/renderers/marketSessions";
import { buildViewport } from "../src/chart/viewport";

describe("market-session renderer", () => {
  it("paints a clipped range box and a text label", () => {
    const candles = Array.from({ length: 10 }, (_, index) => ({ time: index * 60_000, open: 100, high: 105, low: 95, close: 101, volume: 10 }));
    const plot = { left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 };
    const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const ctx = recordingContext();
    drawMarketSessions(ctx, viewport, [{ id: "london", dateKey: "2026-07-15", startTime: candles[1].time, endTime: candles[8].time, open: 100, high: 105, low: 95, close: 101, active: true }]);
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith("LONDON", expect.any(Number), expect.any(Number));
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & { fillRect: ReturnType<typeof vi.fn>; strokeRect: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn> };
}
