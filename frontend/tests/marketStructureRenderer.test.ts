import { describe, expect, it, vi } from "vitest";
import type { MarketStructureSnapshot, StructureBreak, SwingPoint } from "../src/chart/marketStructure";
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

  it("bounds overlay work to visible swings and break events", () => {
    const candles = Array.from({ length: 4_096 }, (_, index) => ({ time: index * 60_000, open: 100, high: 105, low: 95, close: 101, volume: 10, final: true }));
    const plot = { left: 0, top: 0, width: 320, height: 300, right: 320, bottom: 300 };
    const baseViewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });
    const indexToX = vi.fn(baseViewport.indexToX);
    const timeToX = vi.fn(baseViewport.timeToX);
    const viewport = { ...baseViewport, indexToX, timeToX };
    let swingIndexReads = 0;
    let breakTimeReads = 0;
    const swings = candles.map((candle, index) =>
      trackedSwing(index, candle.time, () => {
        swingIndexReads += 1;
      })
    );
    const breaks = candles.slice(1).map((candle, offset) =>
      trackedBreak(candle.time, candles[offset].time, () => {
        breakTimeReads += 1;
      })
    );
    const snapshot: MarketStructureSnapshot = {
      swings,
      breaks,
      fairValueGaps: [],
      trend: "bullish",
      lastConfirmedTime: candles.at(-1)?.time,
      settings: { showStructure: true, showFvg: false, swingStrength: 2 }
    };
    const overlay = recordingContext();
    const visibleCount = viewport.end - viewport.start;

    drawMarketStructureOverlay(overlay, viewport, snapshot);

    expect(overlay.arc).toHaveBeenCalledTimes(visibleCount);
    expect(overlay.stroke).toHaveBeenCalledTimes(visibleCount);
    expect(overlay.fillText).toHaveBeenCalledTimes(visibleCount * 2);
    expect(indexToX).toHaveBeenCalledTimes(visibleCount + 2);
    expect(timeToX).toHaveBeenCalledTimes(visibleCount * 2);
    expect(swingIndexReads).toBeLessThan(visibleCount * 2 + 40);
    expect(breakTimeReads).toBeLessThan(visibleCount * 2 + 40);
  });
});

function trackedSwing(index: number, time: number, onIndexRead: () => void): SwingPoint {
  return {
    get index() {
      onIndexRead();
      return index;
    },
    get time() {
      throw new Error("visible swings must use their exact candle index");
    },
    price: 101,
    kind: "high",
    label: "H",
    confirmedAt: time,
    confirmationIndex: index
  };
}

function trackedBreak(time: number, sourceTime: number, onTimeRead: () => void): StructureBreak {
  return {
    get time() {
      onTimeRead();
      return time;
    },
    price: 101,
    direction: "bullish",
    kind: "bos",
    sourceTime
  };
}

function recordingContext() {
  const values: Record<PropertyKey, unknown> = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), arc: vi.fn(), stroke: vi.fn() };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D & Record<"fillRect" | "strokeRect" | "fillText" | "arc" | "stroke", ReturnType<typeof vi.fn>>;
}
