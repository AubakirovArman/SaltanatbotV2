import { describe, expect, it } from "vitest";
import { detectFootprintInsights } from "../src/chart/footprintInsights";
import type { TradeFootprint } from "../src/chart/tradeFootprint";

describe("live footprint cluster insights", () => {
  it("finds three consecutive diagonal buy imbalances as one stack", () => {
    const footprint = makeFootprint([
      cell(0, 100, 0),
      cell(1, 100, 10),
      cell(2, 100, 10),
      cell(3, 0, 10)
    ]);
    const result = detectFootprintInsights(footprint, []);
    expect(result.imbalances.filter((item) => item.side === "buy").map((item) => item.row)).toEqual([0, 1, 2]);
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]).toMatchObject({ side: "buy", cells: [{ row: 0 }, { row: 1 }, { row: 2 }] });
  });

  it("marks strong buy delta that fails in the lower half as potential buy absorption", () => {
    const footprint = makeFootprint([cell(0, 300, 50)], 300, 50);
    const result = detectFootprintInsights(footprint, [
      { time: 60_000, open: 100, high: 110, low: 95, close: 99, volume: 10 }
    ]);
    expect(result.absorptions).toMatchObject([
      { time: 60_000, x: 20, price: 110, absorbedSide: "buy" }
    ]);
    expect(result.absorptions[0].deltaPercent).toBeCloseTo(71.428, 2);
  });

  it("does not promote tiny rows or delta that closes with the aggressor", () => {
    const footprint = makeFootprint([cell(0, 100, 0), cell(1, 1, 0)], 100, 0);
    const result = detectFootprintInsights(footprint, [
      { time: 60_000, open: 100, high: 110, low: 95, close: 109, volume: 10 }
    ]);
    expect(result.imbalances.map((item) => item.row)).not.toContain(1);
    expect(result.stacks).toEqual([]);
    expect(result.absorptions).toEqual([]);
  });

  it("requires enough normalized prints before suggesting absorption", () => {
    const footprint = makeFootprint([cell(0, 300, 50)], 300, 50, 5);
    const result = detectFootprintInsights(footprint, [
      { time: 60_000, open: 100, high: 110, low: 95, close: 99, volume: 10 }
    ]);
    expect(result.absorptions).toEqual([]);
  });
});

function cell(row: number, buyNotional: number, sellNotional: number) {
  return { time: 60_000, row, x: 20, y: row * 9 + 4.5, buyNotional, sellNotional };
}

function makeFootprint(cells: ReturnType<typeof cell>[], buyNotional = 0, sellNotional = 0, prints = 30): TradeFootprint {
  const delta = buyNotional - sellNotional;
  return {
    cells,
    bars: buyNotional + sellNotional > 0
      ? [{ time: 60_000, x: 20, buyNotional, sellNotional, prints, delta, cumulative: delta }]
      : [],
    buyNotional,
    sellNotional,
    maxCellNotional: Math.max(...cells.flatMap((item) => [item.buyNotional, item.sellNotional]), 0),
    maxAbsDelta: Math.abs(delta)
  };
}
