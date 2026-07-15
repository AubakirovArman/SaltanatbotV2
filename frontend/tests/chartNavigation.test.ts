import { describe, expect, it } from "vitest";
import {
  applyChartPinchNavigation,
  applyChartWheelNavigation,
  beginChartPinchGesture,
  MIN_CHART_ZOOM,
  type ChartNavigationView,
  type ChartTouchPoint
} from "../src/components/chartCanvas/useChartNavigation";
import type { Viewport } from "../src/chart/types";
import type { Candle } from "../src/types";

const candles: Candle[] = Array.from({ length: 200 }, (_, index) => ({
  time: index * 60_000,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 10,
  final: true
}));
const view: ChartNavigationView = { zoom: 1, offset: 20, priceMode: "linear", priceZoom: 1 };
const viewport = {
  plot: { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 },
  barSpacing: 8,
  xToIndex: (x: number) => 80 + x / 8
} as Viewport;

describe("chart wheel and trackpad navigation", () => {
  it("uses proportional zoom instead of a fixed jump per wheel event", () => {
    const next = apply({ deltaY: 60 });
    expect(next.zoom).toBeLessThan(1);
    expect(next.zoom).toBeGreaterThan(0.85);
  });

  it("ignores the tiny inertial tail after a trackpad gesture", () => {
    expect(apply({ deltaY: 0.2 })).toBe(view);
  });

  it("maps a horizontal two-finger gesture to pan without changing zoom", () => {
    const next = apply({ deltaX: 24, deltaY: 2 });
    expect(next.zoom).toBe(1);
    expect(next.offset).toBe(17);
  });

  it("treats browser pinch events as a controlled stronger zoom and clamps spikes", () => {
    const pinch = apply({ deltaY: -8, ctrlKey: true });
    expect(pinch.zoom).toBeGreaterThan(1.09);
    expect(apply({ deltaY: 10_000 }).zoom).toBeGreaterThanOrEqual(0.4);
  });
});

describe("chart touch navigation", () => {
  const start: [ChartTouchPoint, ChartTouchPoint] = [
    { x: 300, y: 200 },
    { x: 500, y: 200 }
  ];
  const gesture = beginChartPinchGesture(start, view, viewport);

  it("zooms around the two-finger midpoint instead of the chart center", () => {
    const next = applyChartPinchNavigation({
      gesture,
      points: [{ x: 250, y: 200 }, { x: 550, y: 200 }],
      view,
      candles,
      viewport
    });
    expect(next.zoom).toBe(1.5);
    expect(next.offset).toBeGreaterThan(view.offset);
    expect(next.crosshair).toBeUndefined();
  });

  it("pans with a moving pinch midpoint without changing its scale", () => {
    const next = applyChartPinchNavigation({
      gesture,
      points: [{ x: 380, y: 200 }, { x: 580, y: 200 }],
      view,
      candles,
      viewport
    });
    expect(next.zoom).toBe(1);
    expect(next.offset).toBe(30);
  });

  it("clamps extreme touch distances to the shared chart zoom limits", () => {
    const next = applyChartPinchNavigation({
      gesture,
      points: [{ x: 300, y: -2_000 }, { x: 500, y: 3_000 }],
      view,
      candles,
      viewport
    });
    expect(next.zoom).toBe(4);
  });

  it("stops scheduling new view objects after reaching the pinch-out boundary", () => {
    const minimumView = { ...view, zoom: MIN_CHART_ZOOM };
    const minimumGesture = beginChartPinchGesture(start, minimumView, viewport);
    const next = applyChartPinchNavigation({
      gesture: minimumGesture,
      points: [{ x: 398, y: 200 }, { x: 402, y: 200 }],
      view: minimumView,
      candles: [],
      viewport: undefined
    });

    expect(next).toBe(minimumView);
  });

  it("ignores malformed touch geometry instead of propagating NaN into rendering", () => {
    const next = applyChartPinchNavigation({
      gesture,
      points: [{ x: Number.NaN, y: 200 }, { x: 500, y: 200 }],
      view,
      candles,
      viewport
    });

    expect(next).toBe(view);
  });
});

function apply(patch: Partial<Parameters<typeof applyChartWheelNavigation>[0]>) {
  return applyChartWheelNavigation({
    view,
    candles,
    viewport,
    deltaX: 0,
    deltaY: 0,
    cursorX: 400,
    ctrlKey: false,
    shiftKey: false,
    ...patch
  });
}
