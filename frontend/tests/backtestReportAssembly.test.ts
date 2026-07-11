import {
  assembleBacktestReport,
  compareBacktestReports,
  serializeBacktestResearchFile,
  type BacktestConfig
} from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/types";

const config: BacktestConfig = {
  initialCapital: 10_000,
  commissionPct: 0,
  slippagePct: 0,
  allowShort: true
};

function candles(source = "Binance"): Candle[] {
  return [
    { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 10, source },
    { time: 60_000, open: 100, high: 102, low: 100, close: 101, volume: 10, source },
    { time: 120_000, open: 101, high: 103, low: 101, close: 102, volume: 10, source }
  ];
}

describe("canonical backtest report assembly", () => {
  it("derives the measured range, metrics and provenance in one immutable result", () => {
    const market = candles();
    const equityCurve = market.map((candle, index) => ({ time: candle.time, equity: 10_000 + index * 10 }));
    const eventTrace = [{ v: 1 as const, barIndex: 2, barTime: 120_000, events: [] }];

    const result = assembleBacktestReport({
      name: "assembled",
      candles: market,
      config,
      trades: [],
      equityCurve,
      markers: [],
      signals: [],
      alerts: [],
      warnings: [],
      eventTrace,
      executionEvents: [],
      varTrace: [{ time: 120_000, vars: { count: 3 } }],
      warmupBars: 1,
      barsInMarket: 0,
      liquidated: false,
      fundingPaid: 0
    });

    expect(result.tested).toEqual({ fromTime: 60_000, toTime: 120_000, bars: 2, warmupBars: 1 });
    expect(result.metrics.finalEquity).toBe(10_020);
    expect(result.provenance.performanceClaimsValid).toBe(true);
    expect(result.eventTrace).toBe(eventTrace);
    expect(result.varTrace?.at(-1)?.vars.count).toBe(3);
  });

  it("bounds invalid warm-up values and handles an empty report deterministically", () => {
    const result = assembleBacktestReport({
      name: "empty",
      candles: [],
      config,
      trades: [],
      equityCurve: [],
      markers: [],
      signals: [],
      alerts: [],
      warnings: [],
      eventTrace: [],
      executionEvents: [],
      warmupBars: Number.POSITIVE_INFINITY,
      barsInMarket: 0,
      liquidated: false,
      fundingPaid: 0
    });

    expect(result.tested).toEqual({ fromTime: 0, toTime: 0, bars: 0, warmupBars: 0 });
    expect(result.provenance.status).toBe("unknown");
    expect(result.metrics.finalEquity).toBe(config.initialCapital);
  });

  it("freezes immutable run identity, assumptions and data-gap evidence", () => {
    const market = [candles()[0], candles()[1], { ...candles()[2], time: 180_000 }];
    const result = assembleBacktestReport({
      name: "metadata",
      candles: market,
      config,
      trades: [],
      equityCurve: market.map((candle) => ({ time: candle.time, equity: 10_000 })),
      markers: [], signals: [], alerts: [], warnings: [], eventTrace: [], executionEvents: [],
      warmupBars: 0, barsInMarket: 0, liquidated: false, fundingPaid: 0,
      context: {
        symbol: "BTCUSDT", timeframe: "1m", exchange: "binance", marketType: "linear",
        priceType: "trade", requestedBars: 4, strategyHash: "strategy-a"
      }
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.metadata).toMatchObject({
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange: "binance",
      marketType: "linear",
      priceType: "trade",
      strategyHash: "strategy-a",
      dataRange: { fromTime: 0, toTime: 180_000 },
      dataQuality: { loadedBars: 3, requestedBars: 4, partiallyLoaded: true, missingBars: 1 }
    });
    expect(result.metadata.assumptions).toHaveLength(8);
    expect(Object.isFrozen(result.metadata)).toBe(true);
    expect(Object.isFrozen(result.metadata.config)).toBe(true);
    expect(Object.isFrozen(result.metadata.dataQuality.gaps)).toBe(true);
    expect(JSON.parse(serializeBacktestResearchFile(result, 123))).toMatchObject({
      schemaVersion: 1,
      kind: "saltanat-backtest-report",
      exportedAt: 123,
      report: { metadata: { comparisonKey: result.metadata.comparisonKey } }
    });
  });

  it("refuses comparison when execution settings or data identity differ", () => {
    const build = (exchange: string, commissionPct: number) => assembleBacktestReport({
      name: "compare",
      candles: candles(),
      config: { ...config, commissionPct },
      trades: [], equityCurve: [], markers: [], signals: [], alerts: [], warnings: [],
      eventTrace: [], executionEvents: [], warmupBars: 0, barsInMarket: 0,
      liquidated: false, fundingPaid: 0,
      context: { symbol: "BTCUSDT", timeframe: "1m", exchange, strategyHash: "same" }
    });
    const baseline = build("binance", 0);
    expect(compareBacktestReports(baseline, build("binance", 0))).toEqual({ comparable: true, differences: [] });
    expect(compareBacktestReports(baseline, build("bybit", 0.1))).toEqual({
      comparable: false,
      differences: ["exchange", "config"]
    });
  });
});
