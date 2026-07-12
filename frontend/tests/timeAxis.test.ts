import { describe, expect, it } from "vitest";
import {
  createChartTimeFormatter,
  normalizeChartTimeZone,
  resolvedChartTimeZone
} from "../src/chart/timeAxis";

describe("chart time-axis zones", () => {
  it("formats absolute timestamps through the requested IANA zone across DST", () => {
    const newYork = createChartTimeFormatter("en", "America/New_York");
    expect(newYork.time(Date.UTC(2026, 2, 8, 6, 30))).toBe("01:30 AM");
    expect(newYork.time(Date.UTC(2026, 2, 8, 7, 30))).toBe("03:30 AM");
  });

  it("uses zone-local calendar boundaries for intraday axis labels", () => {
    const utc = createChartTimeFormatter("en", "UTC");
    const almaty = createChartTimeFormatter("en", "Asia/Almaty");
    const previous = Date.UTC(2026, 6, 11, 23, 30);
    const next = Date.UTC(2026, 6, 12, 0, 30);
    expect(utc.tick(next, previous, 60_000)).toMatch(/Jul 12/);
    expect(almaty.tick(next, previous, 60_000)).toBe(almaty.time(next));
  });

  it("fails closed to exchange UTC for unknown persisted values", () => {
    expect(normalizeChartTimeZone("Mars/Olympus")).toBe("exchange");
    expect(resolvedChartTimeZone(normalizeChartTimeZone("Mars/Olympus"))).toBe("UTC");
  });
});
