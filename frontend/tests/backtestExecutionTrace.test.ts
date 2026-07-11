import {
  BACKTEST_EXECUTION_TRACE_VERSION,
  buildBacktestExecutionTrace,
  type BacktestExecutionEvent
} from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, runBacktest } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";

const MINUTE = 60_000;
const candles: Candle[] = [99, 101, 102, 98].map((close, index) => ({
  time: index * MINUTE,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1_000,
  source: "Binance"
}));

const strategy: StrategyIR = {
  name: "execution-trace",
  inputs: [],
  body: [
    { k: "size", mode: "units", value: { k: "num", v: 1 } },
    { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } },
    { k: "exit", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } }
  ]
};

describe("backtest execution trace v1", () => {
  it("records scheduled fills, position/equity transitions and provenance in stable order", () => {
    const result = runBacktest(strategy, candles, {
      ...DEFAULT_CONFIG,
      commissionPct: 0,
      slippagePct: 0
    });

    expect(BACKTEST_EXECUTION_TRACE_VERSION).toBe(1);
    expect(result.executionTrace.events.map((event) => event.kind)).toEqual([
      "fill_scheduled",
      "position_opened",
      "fill_scheduled",
      "fill_dropped",
      "position_closed",
      "provenance"
    ]);
    expect(result.executionTrace.events[1]).toMatchObject({
      kind: "position_opened",
      barIndex: 2,
      direction: "long",
      price: 102,
      qty: 1,
      equity: 10_000
    });
    expect(result.executionTrace.events[4]).toMatchObject({
      kind: "position_closed",
      reason: "close",
      price: 98,
      pnl: -4,
      equityBefore: 10_000,
      equityAfter: 9_996
    });
    expect(result.executionTrace.events.at(-1)).toMatchObject({
      kind: "provenance",
      provenance: { status: "real", performanceClaimsValid: true }
    });
    expect(JSON.parse(JSON.stringify(result.executionTrace))).toEqual(result.executionTrace);
  });

  it("is byte-deterministic for identical inputs", () => {
    const first = runBacktest(strategy, candles, DEFAULT_CONFIG).executionTrace;
    const second = runBacktest(strategy, candles, DEFAULT_CONFIG).executionTrace;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("normalizes non-finite event numbers to JSON-safe null", () => {
    const events: BacktestExecutionEvent[] = [{
      kind: "funding_charged",
      barIndex: 0,
      barTime: 0,
      amount: Number.NaN,
      equityAfter: Number.POSITIVE_INFINITY
    }];
    const trace = buildBacktestExecutionTrace(events, {
      status: "unknown",
      sources: [],
      chartBars: 0,
      securityBars: 0,
      fallbackBars: 0,
      unknownBars: 0,
      performanceClaimsValid: false
    });
    expect(trace.events[0]).toMatchObject({ amount: null, equityAfter: null });
  });
});
