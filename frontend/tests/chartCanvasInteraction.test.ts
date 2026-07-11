import { describe, expect, it } from "vitest";
import type { DrawingObject } from "../src/chart/drawings";
import { formatVolume, moveDrawing, sameLegend } from "../src/components/chartCanvas/drawingInteraction";

const drawing: DrawingObject = {
  id: "line",
  tool: "trendline",
  points: [{ time: 10, price: 100 }, { time: 20, price: 110 }],
  style: { color: "#fff", width: 1, dashed: false }
};

describe("ChartCanvas interaction helpers", () => {
  it("moves a whole drawing or one handle immutably", () => {
    expect(moveDrawing(drawing, "body", { time: 0, price: 0 }, 5, -2).points).toEqual([{ time: 15, price: 98 }, { time: 25, price: 108 }]);
    expect(moveDrawing(drawing, 1, { time: 30, price: 120 }, 0, 0).points).toEqual([{ time: 10, price: 100 }, { time: 30, price: 120 }]);
    expect(drawing.points[1]).toEqual({ time: 20, price: 110 });
  });

  it("suppresses imperceptible legend churn but detects semantic changes", () => {
    const entry = { id: "btc", symbol: "BTCUSDT", color: "red", base: 100, pct: 1.234, timeframe: "1m" as const, chartType: "line" as const };
    expect(sameLegend([entry], [{ ...entry, pct: 1.233 }])).toBe(true);
    expect(sameLegend([entry], [{ ...entry, symbol: "ETHUSDT" }])).toBe(false);
  });

  it("formats compact chart volumes deterministically", () => {
    expect([formatVolume(999), formatVolume(12_345), formatVolume(1_500_000)]).toEqual(["999", "12.3K", "1.50M"]);
  });
});
