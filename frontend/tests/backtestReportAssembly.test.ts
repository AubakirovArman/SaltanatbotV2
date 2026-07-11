import { assembleBacktestReport, type BacktestConfig } from "@saltanatbotv2/backtest-core";
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
      warmupBars: Number.POSITIVE_INFINITY,
      barsInMarket: 0,
      liquidated: false,
      fundingPaid: 0
    });

    expect(result.tested).toEqual({ fromTime: 0, toTime: 0, bars: 0, warmupBars: 0 });
    expect(result.provenance.status).toBe("unknown");
    expect(result.metrics.finalEquity).toBe(config.initialCapital);
  });
});
