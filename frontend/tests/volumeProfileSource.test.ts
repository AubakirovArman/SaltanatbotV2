import { describe, expect, it, vi } from "vitest";
import {
  candlesIntersectingRange,
  loadRealVolumeProfileCandles,
  volumeProfileRefreshIntervalMs,
  visibleCandleTimeRange,
  VolumeProfileSourceError
} from "../src/chart/volumeProfileSource";
import type { Candle } from "../src/types";

const real = (time: number, volume = 10): Candle => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume,
  source: "Binance public"
});

describe("volume profile source range", () => {
  it("bounds independent-source refresh cadence so a lower timeframe cannot stay ready until the chart bar closes", () => {
    expect(volumeProfileRefreshIntervalMs("1m")).toBe(60_000);
    expect(volumeProfileRefreshIntervalMs("5m")).toBe(300_000);
    expect(volumeProfileRefreshIntervalMs("1h")).toBe(300_000);
    expect(volumeProfileRefreshIntervalMs("1d")).toBe(300_000);
  });

  it("keeps only candles whose source-timeframe span intersects the visible range", () => {
    const selected = candlesIntersectingRange(
      [real(0), real(30_000), real(60_000), real(120_000), real(180_000)],
      { startTime: 60_000, endTime: 180_000 },
      "1m"
    );
    expect(selected.map((candle) => candle.time)).toEqual([30_000, 60_000, 120_000]);
  });

  it("derives an inclusive chart span from the visible candle indexes", () => {
    expect(visibleCandleTimeRange([real(0), real(60_000), real(120_000)], 1, 3, 60_000)).toEqual({
      startTime: 60_000,
      endTime: 180_000
    });
  });

  it("pages backward until the whole visible range is covered", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ candles: [real(60_000)], provider: "Binance public", hasMore: true })
      .mockResolvedValueOnce({ candles: [real(0)], provider: "Binance public", hasMore: false });
    const signal = new AbortController().signal;
    const result = await loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 120_000 },
      signal,
      fetchPage
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0]?.[2]).toBe(signal);
    expect(result.map((candle) => candle.time)).toEqual([0, 60_000]);
  });

  it("fails closed when the candle endpoint reports fallback data", async () => {
    const promise = loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 120_000 },
      signal: new AbortController().signal,
      fetchPage: async () => ({ candles: [{ ...real(0), source: "Fallback after timeout" }], provider: "Fallback after timeout", hasMore: false })
    });
    await expect(promise).rejects.toMatchObject<Partial<VolumeProfileSourceError>>({ code: "fallback" });
  });

  it("does not silently draw a partial or unbounded lower-timeframe profile", async () => {
    const incomplete = loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 120_000 },
      signal: new AbortController().signal,
      fetchPage: async () => ({ candles: [real(60_000)], provider: "Binance public", hasMore: false })
    });
    await expect(incomplete).rejects.toMatchObject<Partial<VolumeProfileSourceError>>({ code: "incomplete" });

    const missingRightEdge = loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 180_000 },
      signal: new AbortController().signal,
      fetchPage: async () => ({ candles: [real(0), real(60_000)], provider: "Binance public", hasMore: false })
    });
    await expect(missingRightEdge).rejects.toMatchObject<Partial<VolumeProfileSourceError>>({ code: "incomplete" });

    const internalGap = loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 180_000 },
      signal: new AbortController().signal,
      fetchPage: async () => ({ candles: [real(0), real(120_000)], provider: "Binance public", hasMore: false })
    });
    await expect(internalGap).rejects.toMatchObject<Partial<VolumeProfileSourceError>>({ code: "incomplete" });

    const formingChartTail = await loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 3_600_000 },
      observedAt: 150_000,
      signal: new AbortController().signal,
      fetchPage: async () => ({ candles: [real(0), real(60_000), real(120_000)], provider: "Binance public", hasMore: false })
    });
    expect(formingChartTail.map((candle) => candle.time)).toEqual([0, 60_000, 120_000]);

    const fetchPage = vi.fn();
    const tooWide = loadRealVolumeProfileCandles({
      timeframe: "1m",
      range: { startTime: 0, endTime: 13_000 * 60_000 },
      signal: new AbortController().signal,
      fetchPage
    });
    await expect(tooWide).rejects.toMatchObject<Partial<VolumeProfileSourceError>>({ code: "range-too-wide" });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
