import { describe, expect, it } from "vitest";
import { buildMarketSessionRanges, DEFAULT_MARKET_SESSION_VISIBILITY, marketSessionAt, supportsMarketSessions } from "../src/chart/marketSessions";
import type { Candle } from "../src/types";

describe("regional market sessions", () => {
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
    const candles = [
      candle(Date.UTC(2026, 6, 15, 13, 30), 100, 105, 98, 103),
      candle(Date.UTC(2026, 6, 15, 14, 0), 103, 108, 101, 107)
    ];
    const ranges = buildMarketSessionRanges(candles, { asia: false, london: false, "new-york": true });
    expect(ranges).toEqual([{
      id: "new-york",
      dateKey: "2026-07-15",
      startTime: candles[0].time,
      endTime: candles[1].time,
      open: 100,
      high: 108,
      low: 98,
      close: 107,
      active: true
    }]);
    expect(DEFAULT_MARKET_SESSION_VISIBILITY).toEqual({ asia: true, london: true, "new-york": true });
    expect(buildMarketSessionRanges(candles, { asia: false, london: false, "new-york": false })).toEqual([]);
  });

  it("limits precise session boxes to one-hour and lower charts", () => {
    expect(["1m", "5m", "15m", "30m", "1h"].every((timeframe) => supportsMarketSessions(timeframe as "1m"))).toBe(true);
    expect(supportsMarketSessions("2h")).toBe(false);
    expect(supportsMarketSessions("1d")).toBe(false);
  });
});

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 10 };
}
