import { describe, expect, it, vi } from "vitest";
import { canvasPixelSize, prepareCanvasContext, resizeCanvasToEntry } from "../src/chart/canvasDensity";

function resizeEntry(width: number, height: number, deviceWidth = 0, deviceHeight = 0) {
  return {
    contentRect: { width, height },
    devicePixelContentBoxSize: deviceWidth
      ? [{ inlineSize: deviceWidth, blockSize: deviceHeight }]
      : undefined
  } as unknown as ResizeObserverEntry;
}

describe("canvas density", () => {
  it("uses CSS size times DPR when the browser reports logical device pixels", () => {
    expect(canvasPixelSize(resizeEntry(320, 180, 320, 180), 2)).toEqual({
      cssWidth: 320,
      cssHeight: 180,
      pixelWidth: 640,
      pixelHeight: 360
    });
  });

  it("keeps a more precise physical size supplied by ResizeObserver", () => {
    expect(canvasPixelSize(resizeEntry(320.2, 180.2, 641, 361), 2)).toEqual({
      cssWidth: 320.2,
      cssHeight: 180.2,
      pixelWidth: 641,
      pixelHeight: 361
    });
  });

  it("only resizes the backing store when its physical size changes", () => {
    const canvas = { width: 640, height: 360 } as HTMLCanvasElement;
    const entry = resizeEntry(320, 180);
    expect(resizeCanvasToEntry(canvas, entry, 2)).toBe(false);
    expect(resizeCanvasToEntry(canvas, resizeEntry(400, 200), 2)).toBe(true);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 800, height: 400 });
  });

  it("maps drawing commands back into logical CSS pixels", () => {
    const setTransform = vi.fn();
    const canvas = {
      width: 640,
      height: 360,
      clientWidth: 320,
      clientHeight: 180,
      getContext: () => ({ setTransform }),
      getBoundingClientRect: () => ({ width: 320, height: 180 })
    } as unknown as HTMLCanvasElement;

    expect(prepareCanvasContext(canvas)).toMatchObject({ width: 320, height: 180 });
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });
});
