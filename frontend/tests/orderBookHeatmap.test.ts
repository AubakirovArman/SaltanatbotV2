import { describe, expect, it } from "vitest";
import { buildHeatmapCells, orderBookSpreadBps, type OrderBookFrame } from "../src/chart/orderBookHeatmap";

describe("order book heatmap model", () => {
  it("groups same-side levels into screen rows and clips old frames", () => {
    const now = 100_000;
    const frames: OrderBookFrame[] = [
      frame(now - 70_000, [[100, 1]], [[101, 1]]),
      frame(now - 1_000, [[100, 2], [100.01, 3]], [[101, 4]])
    ];
    const result = buildHeatmapCells(frames, (price) => price * 2, now, 60_000, 3);
    expect(result.visibleFrames).toBe(1);
    expect(result.cells).toHaveLength(2);
    expect(result.cells.find((cell) => cell.side === "bid")?.notional).toBeCloseTo(500.03);
    expect(result.maxNotional).toBeGreaterThan(400);
  });

  it("reports a midpoint-normalized spread in basis points", () => {
    expect(orderBookSpreadBps(frame(1, [[100, 1]], [[100.1, 1]]))).toBeCloseTo(9.995, 2);
    expect(orderBookSpreadBps(frame(1, [], []))).toBeUndefined();
  });
});

function frame(capturedAt: number, bids: Array<[number, number]>, asks: Array<[number, number]>): OrderBookFrame {
  return { type: "orderbook", symbol: "BTCUSDT", exchange: "binance", bids, asks, sequence: capturedAt, exchangeTs: capturedAt, ts: capturedAt, capturedAt };
}
