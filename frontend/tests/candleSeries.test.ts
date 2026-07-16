import { describe, expect, it } from "vitest";
import { createCandleSeriesBuffer, mergeCandleSeriesBuffer, prependCandleSeriesBuffer, structuralCandlesOf } from "../src/market/candleSeries";
import { analyzeMarketStructure, DEFAULT_MARKET_STRUCTURE_SETTINGS } from "../src/chart/marketStructure";
import { buildRenko } from "../src/chart/renko";
import type { Candle } from "../src/types";

const candle = (time: number, close = time, final = false): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  final
});

describe("candle series buffer", () => {
  it("replaces a provisional tail without copying retained history", () => {
    const initial = createCandleSeriesBuffer([candle(1), candle(2), candle(3, 30)], 12_000);
    const next = mergeCandleSeriesBuffer(initial, candle(3, 31), 12_000);

    expect(next.structuralCandles).toBe(initial.structuralCandles);
    expect(structuralCandlesOf(next.candles)).toBe(initial.structuralCandles);
    expect(next.candles).not.toBe(initial.candles);
    expect([...next.candles]).toEqual([candle(1), candle(2), candle(3, 31)]);
    expect(Object.keys(next.candles)).toEqual(["2"]);
    expect(next.candles.slice()).toEqual([candle(1), candle(2), candle(3, 31)]);
  });

  it("creates a new bounded structural snapshot only for a new bar", () => {
    const initial = createCandleSeriesBuffer([candle(1), candle(2), candle(3)], 3);
    const next = mergeCandleSeriesBuffer(initial, candle(4), 3);

    expect(next.structuralCandles).not.toBe(initial.structuralCandles);
    expect(structuralCandlesOf(next.candles)).toBe(next.candles);
    expect(next.candles).toEqual([candle(2), candle(3), candle(4)]);
    expect(next.tailTime).toBe(4);
  });

  it("promotes a provisional-to-final tail into the structural snapshot", () => {
    const initial = createCandleSeriesBuffer([candle(1, 100, true), candle(2, 101)], 12_000);
    const provisional = mergeCandleSeriesBuffer(initial, candle(2, 102), 12_000);
    const finalized = mergeCandleSeriesBuffer(provisional, candle(2, 103, true), 12_000);

    expect(provisional.structuralCandles).toBe(initial.structuralCandles);
    expect(finalized.structuralCandles).not.toBe(initial.structuralCandles);
    expect(finalized.structuralCandles).toBe(finalized.candles);
    expect(structuralCandlesOf(finalized.candles)).toBe(finalized.candles);
    expect(finalized.candles).toEqual([candle(1, 100, true), candle(2, 103, true)]);
    expect(Object.keys(finalized.candles)).toEqual(["0", "1"]);
  });

  it("makes a finalized same-time candle immediately available to confirmed structure and Renko calculations", () => {
    const initial = createCandleSeriesBuffer([candle(1, 100, true), candle(2, 100)], 12_000);
    const provisional = mergeCandleSeriesBuffer(initial, candle(2, 102), 12_000);
    const beforeFinal = buildRenko(structuralCandlesOf(provisional.candles), { decimals: 2, brickPercent: 1 });
    const structureBeforeFinal = analyzeMarketStructure(structuralCandlesOf(provisional.candles) as Candle[], DEFAULT_MARKET_STRUCTURE_SETTINGS);
    const finalized = mergeCandleSeriesBuffer(provisional, candle(2, 102, true), 12_000);
    const afterFinal = buildRenko(structuralCandlesOf(finalized.candles), { decimals: 2, brickPercent: 1 });
    const structureAfterFinal = analyzeMarketStructure(structuralCandlesOf(finalized.candles) as Candle[], DEFAULT_MARKET_STRUCTURE_SETTINGS);

    expect(beforeFinal).toHaveLength(0);
    expect(structureBeforeFinal.lastConfirmedTime).toBe(1);
    expect(afterFinal.map((brick) => brick.close)).toEqual([101, 102]);
    expect(structureAfterFinal.lastConfirmedTime).toBe(2);
  });

  it("prepends older history while respecting the retention bound", () => {
    const initial = createCandleSeriesBuffer([candle(3), candle(4)], 4);
    const next = prependCandleSeriesBuffer(initial, [candle(1), candle(2)], 4);

    expect(next.candles).toEqual([candle(1), candle(2), candle(3), candle(4)]);
    expect(next.structuralCandles).toBe(next.candles);
  });
});
