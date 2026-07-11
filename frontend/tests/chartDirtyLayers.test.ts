import { describe, expect, it, vi } from "vitest";
import { createChartLayerScheduler } from "../src/chart/dirtyLayers";

function frameDriver() {
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    frames,
    driver: {
      request(callback: FrameRequestCallback) {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancel(id: number) { frames.delete(id); }
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    }
  };
}

describe("chart dirty-layer scheduler", () => {
  it("coalesces rapid crosshair invalidations without drawing the base layer", () => {
    const frames = frameDriver();
    const scheduler = createChartLayerScheduler(frames.driver);
    const base = vi.fn();
    const firstInteraction = vi.fn();
    const latestInteraction = vi.fn();

    scheduler.schedule("interaction", firstInteraction);
    scheduler.schedule("interaction", latestInteraction);
    scheduler.schedule("interaction", latestInteraction);
    expect(frames.frames.size).toBe(1);
    frames.flush();

    expect(base).not.toHaveBeenCalled();
    expect(firstInteraction).not.toHaveBeenCalled();
    expect(latestInteraction).toHaveBeenCalledTimes(1);
  });

  it("renders dirty base before interaction in the same animation frame", () => {
    const frames = frameDriver();
    const scheduler = createChartLayerScheduler(frames.driver);
    const order: string[] = [];

    scheduler.schedule("interaction", () => order.push("interaction"));
    scheduler.schedule("base", () => order.push("base"));
    frames.flush();

    expect(order).toEqual(["base", "interaction"]);
  });

  it("cancels pending work on disposal", () => {
    const frames = frameDriver();
    const scheduler = createChartLayerScheduler(frames.driver);
    const draw = vi.fn();
    scheduler.schedule("base", draw);
    scheduler.dispose();
    frames.flush();
    expect(draw).not.toHaveBeenCalled();
  });
});
