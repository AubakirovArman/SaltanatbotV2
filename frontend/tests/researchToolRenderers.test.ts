import { describe, expect, it, vi } from "vitest";
import type { DrawingObject } from "../src/chart/drawings";
import { drawTextNote } from "../src/chart/renderers/drawingNotes";
import { drawParallelChannel } from "../src/chart/renderers/parallelChannel";
import type { Viewport } from "../src/chart/types";

const viewport = {
  timeToX: (time: number) => time,
  priceToY: (price: number) => 400 - price
} as unknown as Viewport;

function channel(points: DrawingObject["points"]): DrawingObject {
  return { id: "channel", tool: "parallel-channel", points, style: { color: "#4db6ff", width: 1 } };
}

describe("parallel channel renderer", () => {
  it("draws both lines, the fill and a trimmed Δ width label at the midpoint", () => {
    const ctx = context();
    drawParallelChannel(ctx, viewport, channel([
      { time: 10, price: 100 },
      { time: 20, price: 110 },
      { time: 15, price: 102.5 }
    ]), 4);

    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    const [label, x] = ctx.fillText.mock.calls[0];
    expect(label).toBe("Δ 2.5");
    expect(x).toBe(15);
  });

  it("clamps the label precision into the 2..8 range", () => {
    const ctx = context();
    drawParallelChannel(ctx, viewport, channel([
      { time: 10, price: 100 },
      { time: 20, price: 110 },
      { time: 15, price: 105 - 1 / 3 }
    ]), 99);
    expect(ctx.fillText.mock.calls[0][0]).toBe(`Δ ${(1 / 3).toFixed(8).replace(/0+$/, "")}`);

    const coarse = context();
    drawParallelChannel(coarse, viewport, channel([
      { time: 10, price: 100 },
      { time: 20, price: 110 },
      { time: 15, price: 103 }
    ]), 0);
    expect(coarse.fillText.mock.calls[0][0]).toBe("Δ 2");
  });

  it("previews only the base line while the third draft anchor is pending", () => {
    const ctx = context();
    drawParallelChannel(ctx, viewport, channel([
      { time: 10, price: 100 },
      { time: 20, price: 110 }
    ]), 2);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

describe("text note renderer", () => {
  it("renders the anchor dot plus every wrapped, clipped label line in the palette colors", () => {
    const ctx = context();
    const note: DrawingObject = {
      id: "note",
      tool: "text-note",
      points: [{ time: 15, price: 102 }],
      style: { color: "#f7c948", width: 1.5 },
      text: "Support retest\nwatch the volume"
    };
    drawTextNote(ctx, { x: 300, y: 200 }, note, false, { panel: "#fff", text: "#111" });

    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.fillText.mock.calls.map(([line]) => line)).toEqual(["Support retest", "watch the volume"]);
    expect(ctx.fillText.mock.calls[0][1]).toBeGreaterThan(300);
    expect(ctx.fillText.mock.calls[0][2]).toBeLessThan(200);
  });

  it("falls back to an ellipsis placeholder for notes without text", () => {
    const ctx = context();
    const note: DrawingObject = { id: "empty", tool: "text-note", points: [{ time: 15, price: 102 }], style: { color: "#f7c948", width: 1.5 } };
    drawTextNote(ctx, { x: 300, y: 200 }, note, true);
    expect(ctx.fillText.mock.calls.map(([line]) => line)).toEqual(["…"]);
  });
});

function context() {
  const values: Record<PropertyKey, unknown> = {};
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"fillText" | "fill" | "stroke" | "arc" | "clip", ReturnType<typeof vi.fn>>;
}
