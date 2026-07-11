import { describe, expect, it } from "vitest";
import { candleFromClose, candlesFromCloses, jsonResponse, scriptedFetch } from "@saltanatbotv2/test-fixtures";

describe("shared test fixtures", () => {
  it("creates deterministic canonical candles with provenance", () => {
    expect(candlesFromCloses([100, 102], { startTime: 1_000, intervalMs: 300_000, source: "fixture" })).toEqual([
      { time: 1_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000, source: "fixture" },
      { time: 301_000, open: 102, high: 103, low: 101, close: 102, volume: 1_000, source: "fixture" },
    ]);
    expect(() => candleFromClose(0, 0)).toThrow(/positive and finite/);
  });

  it("routes fetch fixtures explicitly and rejects unexpected network access", async () => {
    const fetch = scriptedFetch([{ match: "/time", respond: () => jsonResponse({ serverTime: 123 }) }]);
    await expect(fetch("https://exchange.test/time").then((response) => response.json())).resolves.toEqual({
      serverTime: 123,
    });
    await expect(fetch("https://exchange.test/private")).rejects.toThrow(/Unexpected fixture request/);
  });
});
