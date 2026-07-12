import { describe, expect, it } from "vitest";
import { analyzeMarketStructure, confirmedCandleCount, type MarketStructureSettings } from "../src/chart/marketStructure";
import type { Candle } from "../src/types";

const settings: MarketStructureSettings = { showStructure: true, showFvg: true, swingStrength: 2 };

describe("confirmed market structure", () => {
  it("treats an unfinalized tail as provisional", () => {
    expect(confirmedCandleCount([bar(0, 10, 12, 8, 11, true), bar(1, 11, 20, 5, 19)])).toBe(1);
    expect(confirmedCandleCount([bar(0, 10, 12, 8, 11, true), bar(1, 11, 20, 5, 19, true)])).toBe(2);
  });

  it("confirms and classifies swings only after the right-hand window closes", () => {
    const candles = fromHighLow([
      [10, 6], [12, 7], [16, 8], [13, 7], [11, 5], [14, 7], [18, 9], [14, 8], [12, 6], [13, 8], [15, 9]
    ]);
    const snapshot = analyzeMarketStructure(candles, settings);
    expect(snapshot.swings.map(({ index, label }) => [index, label])).toEqual([[2, "H"], [4, "L"], [6, "HH"], [8, "HL"]]);

    const withoutConfirmation = analyzeMarketStructure(candles.slice(0, 8), settings);
    expect(withoutConfirmation.swings.some((swing) => swing.index === 6)).toBe(false);
  });

  it("requires a close through the level and marks the reversal as CHOCH", () => {
    const candles = [
      bar(0, 10, 11, 8, 10, true), bar(1, 10, 12, 9, 11, true), bar(2, 11, 15, 10, 12, true),
      bar(3, 12, 13, 8, 10, true), bar(4, 10, 12, 6, 9, true),
      bar(5, 9, 16, 8, 14, true), // wick above 15, close remains below
      bar(6, 14, 17, 9, 16, true), // close confirms bullish BOS
      bar(7, 16, 16, 7, 12, true), bar(8, 12, 14, 5, 5, true), // close below swing low confirms bearish CHOCH
      bar(9, 6, 10, 4, 7, true)
    ];
    const snapshot = analyzeMarketStructure(candles, settings);
    expect(snapshot.breaks).toMatchObject([
      { direction: "bullish", kind: "bos", price: 15 },
      { direction: "bearish", kind: "choch", price: 6 }
    ]);
    expect(snapshot.trend).toBe("bearish");
  });

  it("creates three-candle FVG zones and closes them only after full wick mitigation", () => {
    const candles = [
      bar(0, 100, 102, 98, 101, true), bar(1, 101, 108, 101, 107, true), bar(2, 107, 112, 105, 110, true),
      bar(3, 110, 111, 103, 104, true), bar(4, 104, 106, 101, 102, true)
    ];
    const snapshot = analyzeMarketStructure(candles, settings);
    const bullish = snapshot.fairValueGaps.find((gap) => gap.direction === "bullish" && gap.createdTime === 2);
    expect(bullish).toMatchObject({ bottom: 102, top: 105, mitigatedAt: 4 });
  });

  it("does not let the live tail create or mitigate a gap", () => {
    const creationTail = [bar(0, 100, 102, 98, 101, true), bar(1, 101, 108, 101, 107, true), bar(2, 107, 112, 105, 110)];
    expect(analyzeMarketStructure(creationTail, settings).fairValueGaps).toEqual([]);

    const mitigationTail = [...creationTail.slice(0, 2), { ...creationTail[2], final: true }, bar(3, 110, 111, 99, 100)];
    expect(analyzeMarketStructure(mitigationTail, settings).fairValueGaps[0]?.mitigatedAt).toBeUndefined();
  });
});

function fromHighLow(values: Array<[number, number]>): Candle[] {
  return values.map(([high, low], index) => bar(index, (high + low) / 2, high, low, (high + low) / 2, true));
}

function bar(time: number, open: number, high: number, low: number, close: number, final?: boolean): Candle {
  return { time, open, high, low, close, volume: 10, final };
}
