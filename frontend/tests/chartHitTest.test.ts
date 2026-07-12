import { describe, expect, it } from "vitest";
import { candlesFromCloses } from "@saltanatbotv2/test-fixtures";
import type { DrawingObject } from "../src/chart/drawings";
import { hitTest } from "../src/chart/objects/hitTest";
import { buildViewport } from "../src/chart/viewport";

const candles = candlesFromCloses([100, 101, 102, 103, 104, 105]);
const plot = { left: 0, top: 0, width: 600, height: 300, right: 600, bottom: 300 };
const viewport = buildViewport({ candles, plot, zoom: 1, offset: 0, priceMode: "linear" });

function drawing(overrides: Partial<DrawingObject> & Pick<DrawingObject, "id" | "tool" | "points">): DrawingObject {
  return { style: { color: "#fff", width: 1 }, ...overrides };
}

describe("chart drawing hit testing", () => {
  it("distinguishes anchor handles from a trendline body", () => {
    const line = drawing({
      id: "line",
      tool: "trendline",
      points: [{ time: candles[1].time, price: 100 }, { time: candles[4].time, price: 104 }],
    });
    const first = { x: viewport.timeToX(line.points[0].time), y: viewport.priceToY(line.points[0].price) };
    const second = { x: viewport.timeToX(line.points[1].time), y: viewport.priceToY(line.points[1].price) };

    expect(hitTest(viewport, [line], first.x, first.y)).toEqual({ id: "line", part: 0 });
    expect(hitTest(viewport, [line], (first.x + second.x) / 2, (first.y + second.y) / 2)).toEqual({
      id: "line",
      part: "body",
    });
    expect(hitTest(viewport, [line], plot.right, plot.top)).toBeNull();
  });

  it("ignores hidden and locked drawings", () => {
    const point = { time: candles[2].time, price: 102 };
    const x = viewport.timeToX(point.time);
    const y = viewport.priceToY(point.price);
    expect(hitTest(viewport, [drawing({ id: "hidden", tool: "hline", points: [point], hidden: true })], x, y)).toBeNull();
    expect(hitTest(viewport, [drawing({ id: "locked", tool: "hline", points: [point], locked: true })], x, y)).toBeNull();
  });

  it("prefers a selected handle and otherwise returns the top-most object", () => {
    const point = { time: candles[3].time, price: 103 };
    const lower = drawing({ id: "lower", tool: "hline", points: [point] });
    const upper = drawing({ id: "upper", tool: "hline", points: [point] });
    const x = viewport.timeToX(point.time);
    const y = viewport.priceToY(point.price);

    expect(hitTest(viewport, [lower, upper], x + 20, y)).toEqual({ id: "upper", part: "body" });
    expect(hitTest(viewport, [lower, upper], x, y, "lower")).toEqual({ id: "lower", part: 0 });
  });

  it("hits the complete risk area of long/short position tools", () => {
    const position = drawing({
      id: "position",
      tool: "long",
      points: [
        { time: candles[1].time, price: 101 },
        { time: candles[4].time, price: 98 },
        { time: candles[4].time, price: 106 },
      ],
    });
    const x = (viewport.timeToX(candles[1].time) + viewport.timeToX(candles[4].time)) / 2;
    expect(hitTest(viewport, [position], x, viewport.priceToY(103))).toEqual({ id: "position", part: "body" });
  });

  it("selects an anchored VWAP from its vertical anchor guide", () => {
    const avwap = drawing({ id: "avwap", tool: "anchored-vwap", points: [{ time: candles[2].time, price: 102 }] });
    const x = viewport.timeToX(candles[2].time);
    expect(hitTest(viewport, [avwap], x, plot.top + 40)).toEqual({ id: "avwap", part: "body" });
  });
});
