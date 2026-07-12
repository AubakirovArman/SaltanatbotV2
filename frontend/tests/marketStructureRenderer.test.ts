import { describe, expect, it, vi } from "vitest";
import { drawMarketStructureBackground, drawMarketStructureOverlay } from "../src/chart/renderers/marketStructure";
import { buildViewport } from "../src/chart/viewport";

describe("market-structure renderers", () => {
  it("keeps FVG zones behind price and structure labels in the overlay", () => {
    const candles = Array.from({ length: 10 }, (_, index) => ({ time: index, open: 100, high: 105, low: 95, close: 101, volume: 10, final: true }));
    const plot = { left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 };
    const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const snapshot = {
      swings: [{ index: 2, time: 2, price: 104, kind: "high" as const, label: "HH" as const, confirmedAt: 4, confirmationIndex: 4 }],
      breaks: [{ time: 7, price: 104, direction: "bullish" as const, kind: "choch" as const, sourceTime: 2 }],
      fairValueGaps: [{ id: "bullish:3", direction: "bullish" as const, createdTime: 3, top: 103, bottom: 101 }],
      trend: "bullish" as const,
      lastConfirmedTime: 9,
      settings: { showStructure: true, showFvg: true, swingStrength: 2 }
    };
    const background = recordingContext();
    const overlay = recordingContext();

    drawMarketStructureBackground(background, viewport, snapshot);
    drawMarketStructureOverlay(overlay, viewport, snapshot);

    expect(background.fillRect).toHaveBeenCalledTimes(1);
    expect(background.strokeRect).toHaveBeenCalledTimes(1);
    expect(background.fillText).toHaveBeenCalledWith("FVG", expect.any(Number), expect.any(Number));
    expect(overlay.arc).toHaveBeenCalledTimes(1);
    expect(overlay.fillText).toHaveBeenCalledWith("HH", expect.any(Number), expect.any(Number));
    expect(overlay.fillText).toHaveBeenCalledWith("CHOCH ↑", expect.any(Number), expect.any(Number));
  });
});

function recordingContext() {
  const values: Record<PropertyKey, unknown> = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), arc: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"fillRect" | "strokeRect" | "fillText" | "arc", ReturnType<typeof vi.fn>>;
}
