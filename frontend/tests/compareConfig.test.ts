import { describe, expect, it } from "vitest";
import { createCompareOverlay, MAX_COMPARE, normalizeCompareOverlays } from "../src/chart/compareConfig";

describe("compare overlay configuration", () => {
  it("migrates legacy symbols, deduplicates and enforces the cap", () => {
    const overlays = normalizeCompareOverlays(["ETHUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "EURUSD"], "15m", "candles");
    expect(overlays).toHaveLength(MAX_COMPARE);
    expect(overlays.map((overlay) => overlay.symbol)).toEqual(["ETHUSDT", "SOLUSDT", "ADAUSDT"]);
    expect(overlays[0]).toMatchObject({ timeframe: "15m", chartType: "candles" });
  });

  it("normalizes untrusted persisted fields and builds deterministic defaults", () => {
    expect(normalizeCompareOverlays([{ id: "custom", symbol: "SOLUSDT", timeframe: "bad", chartType: "renko", color: "url(bad)", upColor: "#abcdef", downColor: "#123456" }], "4h", "area")).toEqual([
      { id: "custom", symbol: "SOLUSDT", timeframe: "4h", chartType: "line", color: "#f5a623", upColor: "#abcdef", downColor: "#123456" }
    ]);
    expect(createCompareOverlay("ETHUSDT", 1, "1h", "baseline")).toMatchObject({ id: "ETHUSDT", timeframe: "1h", chartType: "baseline", color: "#bd7dff" });
    expect(normalizeCompareOverlays([{ id: "same", symbol: "ETHUSDT" }, { id: "same", symbol: "SOLUSDT" }], "1m", "line")).toHaveLength(1);
  });
});
