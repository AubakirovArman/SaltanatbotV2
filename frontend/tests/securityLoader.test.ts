import { describe, expect, it } from "vitest";
import type { StrategyIR } from "../src/strategy/ir";
import { getSecurityCandles, getSecurityDataEvidence, securitySeriesKey } from "../src/strategy/securityData";
import {
  loadSecurityDataForIr,
  normalizeSecuritySymbol,
  normalizeSecurityTimeframe,
  resolveSecurityRequest,
  SecurityDataLoadError
} from "../src/strategy/securityLoader";
import { collectSecurityRequirements } from "../src/strategy/securityRequirements";
import type { Candle } from "../src/types";

describe("security requirements", () => {
  it("collects request.security dependencies anywhere in the IR", () => {
    const ir: StrategyIR = {
      name: "mtf",
      inputs: [],
      init: [
        {
          k: "setvar",
          name: "dailyClose",
          value: {
            k: "security",
            symbol: "NASDAQ:AAPL",
            timeframe: "D",
            source: { k: "price", field: "close" }
          }
        }
      ],
      body: [
        {
          k: "entry",
          direction: "long",
          when: {
            k: "compare",
            op: ">",
            a: { k: "price", field: "close" },
            b: {
              k: "security",
              symbol: "current",
              timeframe: "60",
              source: {
                k: "ma",
                kind: "ema",
                period: { k: "num", v: 21 },
                source: { k: "price", field: "close" }
              }
            }
          }
        }
      ]
    };

    expect(collectSecurityRequirements(ir)).toEqual([
      { symbol: "NASDAQ:AAPL", timeframe: "D" },
      { symbol: "current", timeframe: "60" }
    ]);
  });
});

describe("security loader normalization", () => {
  it("maps Pine symbols and timeframes to supported app market keys", () => {
    expect(normalizeSecuritySymbol("BINANCE:BTCUSDT", "ETHUSDT")).toBe("BTCUSDT");
    expect(normalizeSecuritySymbol("syminfo.tickerid", "ETHUSDT")).toBe("ETHUSDT");

    expect(normalizeSecurityTimeframe("chart", "15m")).toBe("15m");
    expect(normalizeSecurityTimeframe("60", "1m")).toBe("1h");
    expect(normalizeSecurityTimeframe("240", "1m")).toBe("4h");
    expect(normalizeSecurityTimeframe("D", "1m")).toBe("1d");
    expect(normalizeSecurityTimeframe("1M", "1m")).toBe("1M");
    expect(normalizeSecurityTimeframe("3", "1m")).toBeUndefined();
    expect(securitySeriesKey("BTCUSDT", "1m")).not.toBe(securitySeriesKey("BTCUSDT", "1M"));
  });

  it("keeps both raw Pine lookup keys and normalized fetch keys", () => {
    const resolved = resolveSecurityRequest(
      { symbol: "NASDAQ:AAPL", timeframe: "D" },
      { symbol: "BTCUSDT", timeframe: "1m" }
    );

    expect(resolved).toMatchObject({
      fetchSymbol: "AAPL",
      fetchTimeframe: "1d",
      sameAsChart: false
    });
    expect(resolved?.keys).toContain(securitySeriesKey("NASDAQ:AAPL", "D"));
    expect(resolved?.keys).toContain(securitySeriesKey("AAPL", "1d"));
  });

  it("records same-chart dependencies as resolved instead of treating them as fallback", async () => {
    const chartCandles = candles();
    const context = await loadSecurityDataForIr(securityIr("current", "chart"), {
      symbol: "BTCUSDT",
      timeframe: "1m",
      chartCandles
    });

    expect(getSecurityCandles(context, "current", "chart")).toBe(chartCandles);
    expect(getSecurityDataEvidence(context)).toMatchObject({
      version: 1,
      requested: [{ symbol: "current", timeframe: "chart" }],
      resolved: [{ source: "chart", fetchSymbol: "BTCUSDT", fetchTimeframe: "1m", bars: 2 }],
      unresolved: []
    });
  });

  it("fails closed with structured evidence for unsupported requests", async () => {
    const promise = loadSecurityDataForIr(securityIr("current", "3"), {
      symbol: "BTCUSDT",
      timeframe: "1m",
      chartCandles: candles()
    });

    await expect(promise).rejects.toBeInstanceOf(SecurityDataLoadError);
    await expect(promise).rejects.toMatchObject({
      code: "UNRESOLVED_SECURITY_DATA",
      evidence: {
        requested: [{ symbol: "current", timeframe: "3" }],
        resolved: [],
        unresolved: [{ symbol: "current", timeframe: "3", reason: "unsupported-request" }]
      }
    });
  });

  it("returns unresolved evidence only when an approximate preview explicitly opts in", async () => {
    const context = await loadSecurityDataForIr(securityIr("current", "3"), {
      symbol: "BTCUSDT",
      timeframe: "1m",
      chartCandles: candles(),
      unresolvedPolicy: "return-evidence"
    });

    expect(getSecurityDataEvidence(context)?.unresolved).toMatchObject([
      { symbol: "current", timeframe: "3", reason: "unsupported-request" }
    ]);
  });
});

function securityIr(symbol: string, timeframe: string): StrategyIR {
  return {
    name: "security-loader",
    inputs: [],
    body: [{
      k: "plot",
      label: "external",
      color: "#fff",
      value: { k: "security", symbol, timeframe, source: { k: "price", field: "close" } }
    }]
  };
}

function candles(): Candle[] {
  return [0, 60_000].map((time) => ({
    time,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
    source: "Binance"
  }));
}
