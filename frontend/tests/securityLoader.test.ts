import { describe, expect, it } from "vitest";
import type { StrategyIR } from "../src/strategy/ir";
import { securitySeriesKey } from "../src/strategy/securityData";
import { normalizeSecuritySymbol, normalizeSecurityTimeframe, resolveSecurityRequest } from "../src/strategy/securityLoader";
import { collectSecurityRequirements } from "../src/strategy/securityRequirements";

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
});
