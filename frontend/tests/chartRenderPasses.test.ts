import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  candles: vi.fn(),
  lineBreak: vi.fn(),
  lineArea: vi.fn(),
  volumeProfile: vi.fn(),
  indicator: vi.fn(),
  drawings: vi.fn()
}));

vi.mock("../src/chart/renderers/candles", () => ({ drawCandles: calls.candles }));
vi.mock("../src/chart/renderers/lineBreak", () => ({ drawLineBreak: calls.lineBreak }));
vi.mock("../src/chart/renderers/lineArea", () => ({ drawLineArea: calls.lineArea }));
vi.mock("../src/chart/renderers/volumeProfile", () => ({ drawVolumeProfile: calls.volumeProfile }));
vi.mock("../src/chart/renderers/drawingRenderers", () => ({ drawDrawings: calls.drawings }));
vi.mock("../src/chart/renderers/indicatorRenderers", () => ({
  drawBollinger: vi.fn(),
  drawMacdPanel: vi.fn(),
  drawOscillatorPanel: vi.fn(),
  drawRsiPanel: vi.fn(),
  drawSeriesLine: calls.indicator,
  drawStochasticPanel: vi.fn()
}));

import {
  drawChartIndicators,
  drawChartOverlays,
  drawChartPrimary,
  prepareChartRender,
  withChartRenderInput
} from "../src/chart/ChartEngine";
import type { ChartRenderInput } from "../src/chart/ChartEngine";

function context(): CanvasRenderingContext2D {
  const values: Record<PropertyKey, unknown> = {
    measureText: () => ({ width: 20 })
  };
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as CanvasRenderingContext2D;
}

const candles = Array.from({ length: 30 }, (_, index) => ({
  time: index * 60_000,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 1_000
}));

const input: ChartRenderInput = {
  width: 800,
  height: 400,
  candles,
  chartType: "candles",
  decimals: 2,
  view: { zoom: 1, offset: 0, priceMode: "linear" },
  indicators: [{ id: "sma", kind: "sma", label: "SMA", enabled: true, color: "#fff", period: 5 }],
  drawings: [],
  showVolume: false
};

beforeEach(() => vi.clearAllMocks());

describe("chart render passes", () => {
  it("keeps primary, indicator and overlay renderers isolated", () => {
    const plan = prepareChartRender(input);
    const ctx = context();

    drawChartPrimary(ctx, plan);
    expect(calls.candles).toHaveBeenCalledTimes(1);
    expect(calls.indicator).not.toHaveBeenCalled();
    expect(calls.drawings).not.toHaveBeenCalled();

    vi.clearAllMocks();
    drawChartIndicators(ctx, plan);
    expect(calls.indicator).toHaveBeenCalledTimes(1);
    expect(calls.candles).not.toHaveBeenCalled();
    expect(calls.drawings).not.toHaveBeenCalled();

    vi.clearAllMocks();
    drawChartOverlays(ctx, plan);
    expect(calls.drawings).toHaveBeenCalledTimes(1);
    expect(calls.candles).not.toHaveBeenCalled();
    expect(calls.indicator).not.toHaveBeenCalled();
  });

  it("rebinds volatile overlays without rebuilding render geometry", () => {
    const plan = prepareChartRender(input);
    const rebound = withChartRenderInput(plan, {
      signals: [{ time: 60_000, price: 101, kind: "buy" }]
    });

    expect(rebound).not.toBe(plan);
    expect(rebound.input.signals).toHaveLength(1);
    if (!plan.empty && !rebound.empty) {
      expect(rebound.viewport).toBe(plan.viewport);
      expect(rebound.computed).toBe(plan.computed);
    }
  });

  it("moves price indicators into independently scaled panes when configured", () => {
    const plan = prepareChartRender({
      ...input,
      indicators: [{ ...input.indicators[0], pane: "separate", scalePlacement: "left" }]
    });
    const basePlan = prepareChartRender(input);
    expect(plan.empty).toBe(false);
    if (plan.empty || basePlan.empty) return;
    expect(plan.lowerIndicators).toMatchObject([{ id: "sma", pane: "separate", scalePlacement: "left" }]);
    expect(plan.plot.height).toBeLessThan(basePlan.plot.height);
  });

  it("routes hollow candles and step lines through their specialized renderer modes", () => {
    const ctx = context();
    drawChartPrimary(ctx, prepareChartRender({ ...input, chartType: "hollow" }));
    expect(calls.candles).toHaveBeenCalledWith(expect.any(Object), true);

    drawChartPrimary(ctx, prepareChartRender({ ...input, chartType: "step" }));
    expect(calls.lineArea).toHaveBeenCalledWith(expect.any(Object), false, true);
  });

  it("compresses source candles before rendering Three Line Break", () => {
    const ctx = context();
    const plan = prepareChartRender({ ...input, chartType: "linebreak" });
    drawChartPrimary(ctx, plan);

    expect(calls.lineBreak).toHaveBeenCalledTimes(1);
    if (!plan.empty) expect(plan.data.length).toBeLessThan(candles.length);
  });

  it("renders the visible-range profile only when requested", () => {
    const ctx = context();
    drawChartPrimary(ctx, prepareChartRender({ ...input, showVolumeProfile: true }));
    expect(calls.volumeProfile).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    drawChartPrimary(ctx, prepareChartRender({ ...input, showVolumeProfile: false }));
    expect(calls.volumeProfile).not.toHaveBeenCalled();
  });
});
