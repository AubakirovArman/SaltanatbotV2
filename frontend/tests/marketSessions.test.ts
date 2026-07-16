import { afterEach, describe, expect, it, vi } from "vitest";
import { appendMarketSessionTail, buildMarketSessionRanges, DEFAULT_MARKET_SESSION_VISIBILITY, marketSessionAt, supportsMarketSessions } from "../src/chart/marketSessions";
import type { Candle } from "../src/types";

describe("regional market sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses DST-aware London local hours", () => {
    expect(marketSessionAt("london", Date.UTC(2026, 0, 15, 8, 0)).active).toBe(true);
    expect(marketSessionAt("london", Date.UTC(2026, 0, 15, 7, 59)).active).toBe(false);
    expect(marketSessionAt("london", Date.UTC(2026, 6, 15, 7, 0)).active).toBe(true);
    expect(marketSessionAt("london", Date.UTC(2026, 6, 15, 16, 0)).active).toBe(false);
  });

  it("uses DST-aware New York 09:30–16:00 local hours", () => {
    expect(marketSessionAt("new-york", Date.UTC(2026, 0, 15, 14, 30)).active).toBe(true);
    expect(marketSessionAt("new-york", Date.UTC(2026, 0, 15, 21, 0)).active).toBe(false);
    expect(marketSessionAt("new-york", Date.UTC(2026, 6, 15, 13, 30)).active).toBe(true);
    expect(marketSessionAt("new-york", Date.UTC(2026, 6, 15, 20, 0)).active).toBe(false);
  });

  it("keeps Tokyo fixed at 09:00–18:00 local time", () => {
    expect(marketSessionAt("asia", Date.UTC(2026, 6, 15, 0, 0))).toMatchObject({ active: true, dateKey: "2026-07-15" });
    expect(marketSessionAt("asia", Date.UTC(2026, 6, 15, 9, 0)).active).toBe(false);
  });

  it("aggregates session OHLC ranges and marks only the live tail active", () => {
    const candles = [candle(Date.UTC(2026, 6, 15, 13, 30), 100, 105, 98, 103), candle(Date.UTC(2026, 6, 15, 14, 0), 103, 108, 101, 107)];
    const ranges = buildMarketSessionRanges(candles, { asia: false, london: false, "new-york": true });
    expect(ranges).toEqual([
      {
        id: "new-york",
        dateKey: "2026-07-15",
        startTime: candles[0].time,
        endTime: candles[1].time,
        open: 100,
        high: 108,
        low: 98,
        close: 107,
        active: true
      }
    ]);
    expect(DEFAULT_MARKET_SESSION_VISIBILITY).toEqual({ asia: true, london: true, "new-york": true });
    expect(buildMarketSessionRanges(candles, { asia: false, london: false, "new-york": false })).toEqual([]);
  });

  it("limits precise session boxes to one-hour and lower charts", () => {
    expect(["1m", "5m", "15m", "30m", "1h"].every((timeframe) => supportsMarketSessions(timeframe as "1m"))).toBe(true);
    expect(supportsMarketSessions("2h")).toBe(false);
    expect(supportsMarketSessions("1d")).toBe(false);
  });

  it("patches only the forming tail over immutable historical ranges", () => {
    const first = candle(Date.UTC(2026, 6, 15, 13, 30), 100, 105, 98, 103);
    const ranges = buildMarketSessionRanges([first], { asia: false, london: false, "new-york": true });
    const tail = candle(Date.UTC(2026, 6, 15, 14, 0), 103, 108, 101, 107);
    const next = appendMarketSessionTail(ranges, tail, { asia: false, london: false, "new-york": true });

    expect(ranges[0]).toMatchObject({ endTime: first.time, high: 105, close: 103, active: true });
    expect(next[0]).toMatchObject({ endTime: tail.time, high: 108, low: 98, close: 107, active: true });
  });

  it("supports an end-exclusive history without copying the candle array", () => {
    const candles = [candle(Date.UTC(2026, 6, 15, 13, 30), 100, 105, 98, 103), candle(Date.UTC(2026, 6, 15, 14, 0), 103, 108, 101, 107), candle(Date.UTC(2026, 6, 15, 14, 30), 107, 112, 104, 111)];
    const slice = vi.fn(() => {
      throw new Error("buildMarketSessionRanges must not copy history");
    });
    const history = new Proxy(candles, {
      get(target, property, receiver) {
        if (property === "slice") return slice;
        return Reflect.get(target, property, receiver);
      }
    });
    const visibility = { asia: false, london: false, "new-york": true };
    const structural = buildMarketSessionRanges(history, visibility, 2);
    const patched = appendMarketSessionTail(structural, candles[2], visibility);

    expect(slice).not.toHaveBeenCalled();
    expect(structural[0]).toMatchObject({ endTime: candles[1].time, high: 108, close: 107, active: true });
    expect(patched).toEqual(buildMarketSessionRanges(candles, visibility));
  });

  it("caches all regional memberships in one timestamp entry", () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const time = Date.UTC(2097, 10, 17, 12, 34);
    const first = marketSessionAt("asia", time);

    expect(first.dateKey).toBe("2097-11-17");
    expect(formatToParts).toHaveBeenCalledTimes(3);
    expect(marketSessionAt("london", time).dateKey).toBe("2097-11-17");
    expect(marketSessionAt("new-york", time).dateKey).toBe("2097-11-17");
    expect(formatToParts).toHaveBeenCalledTimes(3);
  });

  it("keeps the fast chronological builder equivalent for unordered input", () => {
    const candles = [candle(Date.UTC(2026, 6, 15, 14, 30), 107, 112, 104, 111), candle(Date.UTC(2026, 6, 15, 13, 30), 100, 105, 98, 103), candle(Date.UTC(2026, 6, 15, 14, 0), 103, 108, 101, 107)];

    expect(buildMarketSessionRanges(candles, { asia: false, london: false, "new-york": true })).toEqual([
      {
        id: "new-york",
        dateKey: "2026-07-15",
        startTime: candles[0].time,
        endTime: candles[2].time,
        open: 107,
        high: 112,
        low: 98,
        close: 107,
        active: true
      }
    ]);
  });
});

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 10 };
}
