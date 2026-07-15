import { buildBacktestDataProvenance } from "@saltanatbotv2/backtest-core";
import { createSecurityDataBundle, securitySeriesKey } from "@saltanatbotv2/strategy-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, runBacktest } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";

function candle(time: number, source?: string): Candle {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 1_000, source };
}

const inertStrategy: StrategyIR = { name: "provenance", inputs: [], body: [] };

describe("backtest market-data provenance", () => {
  it("validates performance claims only when every candle has a real source", () => {
    const provenance = buildBacktestDataProvenance([candle(0, "Binance"), candle(60_000, "Binance")]);

    expect(provenance).toMatchObject({
      status: "real",
      chartBars: 2,
      securityBars: 0,
      fallbackBars: 0,
      unknownBars: 0,
      performanceClaimsValid: true
    });
    expect(provenance.sources).toEqual([{ scope: "chart", source: "Binance", kind: "real", bars: 2 }]);
  });

  it("classifies synthetic and routed fallback candles as fallback", () => {
    const provenance = buildBacktestDataProvenance([
      candle(0, "Synthetic realtime"),
      candle(60_000, "Fallback after Binance")
    ]);

    expect(provenance.status).toBe("fallback");
    expect(provenance.fallbackBars).toBe(2);
    expect(provenance.performanceClaimsValid).toBe(false);
  });

  it("marks real and unverified data mixtures as mixed", () => {
    const provenance = buildBacktestDataProvenance([candle(0, "Bybit"), candle(60_000)]);

    expect(provenance.status).toBe("mixed");
    expect(provenance.unknownBars).toBe(1);
    expect(provenance.performanceClaimsValid).toBe(false);
  });

  it("includes request.security sources in the report contract", () => {
    const provenance = buildBacktestDataProvenance(
      [candle(0, "Binance")],
      new Map([["ETHUSDT|60", [candle(0, "Bybit"), candle(60_000, "Bybit")]]])
    );

    expect(provenance).toMatchObject({ status: "real", chartBars: 1, securityBars: 2, performanceClaimsValid: true });
    expect(provenance.sources).toContainEqual({ scope: "security", source: "Bybit", kind: "real", bars: 2 });
  });

  it("includes requested/resolved/unresolved evidence and invalidates incomplete runs", () => {
    const resolvedKey = securitySeriesKey("ETHUSDT", "60");
    const unresolvedKey = securitySeriesKey("SOLUSDT", "60");
    const external = [candle(0, "Bybit"), candle(60_000, "Bybit")];
    const provenance = buildBacktestDataProvenance(
      [candle(0, "Binance")],
      createSecurityDataBundle({ [resolvedKey]: external }, {
        version: 1,
        requested: [
          { key: resolvedKey, symbol: "ETHUSDT", timeframe: "60" },
          { key: unresolvedKey, symbol: "SOLUSDT", timeframe: "60" }
        ],
        resolved: [{
          key: resolvedKey,
          symbol: "ETHUSDT",
          timeframe: "60",
          fetchSymbol: "ETHUSDT",
          fetchTimeframe: "1h",
          source: "external",
          bars: 2,
          keys: [resolvedKey]
        }],
        unresolved: [{ key: unresolvedKey, symbol: "SOLUSDT", timeframe: "60", fetchSymbol: "SOLUSDT", reason: "empty-response" }]
      })
    );

    expect(provenance.status).toBe("real");
    expect(provenance.performanceClaimsValid).toBe(false);
    expect(provenance.securityRequests).toEqual({
      version: 1,
      requested: [
        { key: resolvedKey, symbol: "ETHUSDT", timeframe: "60" },
        { key: unresolvedKey, symbol: "SOLUSDT", timeframe: "60" }
      ],
      resolved: [{
        key: resolvedKey,
        symbol: "ETHUSDT",
        timeframe: "60",
        fetchSymbol: "ETHUSDT",
        fetchTimeframe: "1h",
        source: "external",
        bars: 2,
        keys: [resolvedKey]
      }],
      unresolved: [{ key: unresolvedKey, symbol: "SOLUSDT", timeframe: "60", fetchSymbol: "SOLUSDT", reason: "empty-response" }]
    });
  });

  it("does not count alias keys that reference the same external candles more than once", () => {
    const series = [candle(0, "Bybit"), candle(60_000, "Bybit")];
    const provenance = buildBacktestDataProvenance([candle(0, "Binance")], {
      "ETHUSDT|60": series,
      "ETHUSDT|1H": series
    });

    expect(provenance.securityBars).toBe(2);
    expect(provenance.sources).toContainEqual({ scope: "security", source: "Bybit", kind: "real", bars: 2 });
  });

  it("attaches provenance to every assembled backtest result", () => {
    const result = runBacktest(
      inertStrategy,
      [candle(0, "Synthetic realtime"), candle(60_000, "Synthetic realtime")],
      DEFAULT_CONFIG
    );

    expect(result.provenance.status).toBe("fallback");
    expect(result.provenance.chartBars).toBe(2);
    expect(result.provenance.performanceClaimsValid).toBe(false);
  });
});
