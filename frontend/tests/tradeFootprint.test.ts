import { describe, expect, it } from "vitest";
import { aggregateTradeFootprint, tradeFlowDeltaPercent } from "../src/chart/tradeFootprint";
import type { Viewport } from "../src/chart/types";

describe("trade footprint aggregation", () => {
  it("groups prints by candle and screen-price row while preserving aggressor notional", () => {
    const footprint = aggregateTradeFootprint([
      { id: "1", price: 100, size: 2, side: "buy", exchangeTs: 61_000 },
      { id: "2", price: 100.05, size: 1, side: "sell", exchangeTs: 62_000 },
      { id: "3", price: 101, size: 1, side: "buy", exchangeTs: 121_000 }
    ], viewport());
    expect(footprint.cells).toHaveLength(2);
    expect(footprint.cells[0].x).toBe(20);
    expect(footprint.cells[0]).toMatchObject({ buyNotional: 200, sellNotional: 100.05 });
    expect(footprint.bars).toHaveLength(2);
    expect(footprint.bars[0].x).toBe(20);
    expect(footprint.bars[0].delta).toBeCloseTo(99.95);
    expect(footprint.bars[1].cumulative).toBeCloseTo(200.95);
    expect(tradeFlowDeltaPercent(200, 100)).toBeCloseTo(33.333);
  });

  it("excludes trades outside the visible time or price range", () => {
    const footprint = aggregateTradeFootprint([
      { id: "1", price: 500, size: 1, side: "buy", exchangeTs: 61_000 },
      { id: "2", price: 100, size: 1, side: "sell", exchangeTs: 3_000_000 }
    ], viewport());
    expect(footprint.cells).toEqual([]);
    expect(footprint.bars).toEqual([]);
  });
});

function viewport(): Viewport {
  return {
    plot: { left: 0, top: 0, width: 500, height: 300, right: 500, bottom: 300 },
    scale: { min: 90, max: 110, mode: "linear", base: 100, y: (price) => (110 - price) * 10, priceAt: (y) => 110 - y / 10 },
    barSpacing: 20, start: 0, end: 20, barTimeMs: 60_000, lastTime: 1_200_000, lastIndex: 20,
    indexToX: (index) => index * 20,
    xToIndex: (x) => x / 20,
    timeToX: (time) => time / 3_000,
    xToTime: (x) => x * 3_000,
    priceToY: (price) => (110 - price) * 10,
    yToPrice: (y) => 110 - y / 10
  };
}
