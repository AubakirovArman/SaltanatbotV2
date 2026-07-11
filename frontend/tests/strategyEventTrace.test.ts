import { describe, expect, it } from "vitest";
import { evaluateBar, runInit } from "../../backend/src/trading/strategy/evaluator.js";
import {
  STRATEGY_TRACE_VERSION,
  traceBarIntents,
  type StrategyBarTrace
} from "@saltanatbotv2/strategy-core";
import { DEFAULT_CONFIG, previewStrategy, runBacktest } from "../src/strategy/backtest";
import type { BoolExpr, StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";
import golden from "./strategyEventTrace.golden.json";

const MINUTE = 60_000;
const candles: Candle[] = [99, 101, 102, 98].map((close, index) => ({
  time: index * MINUTE,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1000
}));

const entryCondition: BoolExpr = {
  k: "logic",
  op: "and",
  a: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } },
  b: { k: "compare", op: ">=", a: { k: "var", name: "count" }, b: { k: "num", v: 2 } }
};

const ir: StrategyIR = {
  name: "trace-golden",
  inputs: [],
  init: [{ k: "setvar", name: "count", value: { k: "num", v: 0 } }],
  body: [
    { k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } },
    { k: "size", mode: "units", value: { k: "num", v: 1 } },
    { k: "stop", mode: "price", value: { k: "num", v: 95 } },
    { k: "target", mode: "price", value: { k: "num", v: 110 } },
    { k: "trail", mode: "percent", value: { k: "num", v: 2 } },
    { k: "entry", direction: "long", when: entryCondition },
    { k: "exit", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } },
    { k: "alert", message: "go {close}", args: { close: { k: "price", field: "close" } }, when: entryCondition },
    { k: "marker", dir: "up", label: "go", when: entryCondition }
  ]
};

describe("strategy event trace v1", () => {
  it("matches one checked-in golden trace in preview, backtest and paper/live evaluator paths", () => {
    const expected = golden as StrategyBarTrace[];
    const preview = previewStrategy(ir, candles);
    const backtest = runBacktest(ir, candles, {
      ...DEFAULT_CONFIG,
      initialCapital: 10_000,
      commissionPct: 0,
      slippagePct: 0
    });
    const variables = new Map<string, number>();
    runInit(ir, candles, variables);
    const liveTrace = candles.map((_, index) => evaluateBar(ir, candles, index, variables).trace);

    expect(STRATEGY_TRACE_VERSION).toBe(1);
    expect(preview.eventTrace).toEqual(expected);
    expect(backtest.eventTrace).toEqual(expected);
    expect(liveTrace).toEqual(expected);
  });

  it("normalizes non-finite numeric intent values to JSON-safe null", () => {
    const trace = traceBarIntents(
      { exit: false, alerts: [], markers: [], stop: { mode: "price", value: NaN } },
      2,
      123
    );
    expect(trace.events).toEqual([{ kind: "stop", mode: "price", value: null }]);
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });
});
