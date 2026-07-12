import { describe, expect, it, vi } from "vitest";
import { drawTimeAxis } from "../src/chart/renderers/chartChrome";
import type { ChartTheme, Viewport } from "../src/chart/types";

const theme = { background: "#000", panel: "#111", grid: "#222", text: "#fff", muted: "#888", up: "green", down: "red", accent: "blue", areaFill: "transparent" } satisfies ChartTheme;

describe("chart time axis", () => {
  it("keeps sparse price-based labels apart and resolves their exact viewport time", () => {
    const ctx = context();
    const xToTime = vi.fn(() => Date.UTC(2026, 6, 12, 10, 30));
    drawTimeAxis(ctx, {
      plot: { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 },
      start: 0,
      end: 10,
      barSpacing: 8,
      barTimeMs: 60_000,
      indexToX: (index) => index * 8 + 4,
      xToTime
    } as unknown as Viewport, theme);

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(xToTime).toHaveBeenCalledWith(4);
  });
});

function context() {
  const values: Record<PropertyKey, unknown> = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"fillText", ReturnType<typeof vi.fn>>;
}
