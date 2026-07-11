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

type LegacySemanticTrace = { v: 1; barIndex: number; barTime: number; events: StrategyBarTrace["events"] };
const semanticV1 = (trace: StrategyBarTrace[]): LegacySemanticTrace[] => trace.map(({ barIndex, barTime, events }) => ({
  v: 1,
  barIndex,
  barTime,
  events
}));

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

describe("strategy event trace v2", () => {
  it("preserves the v1 semantic golden and matches v2 explanations across every runtime path", () => {
    const expected = golden as LegacySemanticTrace[];
    const preview = previewStrategy(ir, candles);
    const backtest = runBacktest(ir, candles, {
      ...DEFAULT_CONFIG,
      initialCapital: 10_000,
      commissionPct: 0,
      slippagePct: 0
    });
    const variables = new Map<string, number>();
    runInit(ir, candles, variables);
    const liveTrace = candles.map((_, index) => evaluateBar(ir, candles, index, variables).trace!);

    expect(STRATEGY_TRACE_VERSION).toBe(2);
    expect(semanticV1(preview.eventTrace)).toEqual(expected);
    expect(semanticV1(backtest.eventTrace)).toEqual(expected);
    expect(semanticV1(liveTrace)).toEqual(expected);
    expect(preview.eventTrace).toEqual(backtest.eventTrace);
    expect(backtest.eventTrace).toEqual(liveTrace);
    expect(backtest.eventTrace[1].explanations).toContainEqual({
      path: "body.5.when",
      role: "condition",
      expressionKind: "logic",
      result: true,
      evaluations: 1,
      trueCount: 1
    });
    expect(backtest.eventTrace[1].variableChanges).toEqual([{ name: "count", before: 1, after: 2 }]);
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

  it("aggregates repeated statement explanations and emits one compact variable diff", () => {
    const repeated: StrategyIR = {
      name: "repeat-explanation",
      inputs: [],
      body: [{
        k: "repeat",
        count: { k: "num", v: 3 },
        body: [{ k: "setvar", name: "sum", value: { k: "arith", op: "+", a: { k: "var", name: "sum" }, b: { k: "num", v: 1 } } }]
      }]
    };

    const trace = evaluateBar(repeated, candles.slice(0, 1), 0).trace!;
    expect(trace.explanations).toContainEqual({
      path: "body.0.body.0.value",
      role: "value",
      expressionKind: "arith",
      result: 3,
      evaluations: 3
    });
    expect(trace.variableChanges).toEqual([{ name: "sum", before: null, after: 3 }]);
  });

  it("bounds explanations per bar and reports truncation", () => {
    const bounded: StrategyIR = {
      name: "bounded-explanations",
      inputs: [],
      body: Array.from({ length: 300 }, (_, index) => ({
        k: "setvar" as const,
        name: `value_${index}`,
        value: { k: "num" as const, v: index }
      }))
    };

    const trace = evaluateBar(bounded, candles.slice(0, 1), 0).trace!;
    expect(trace.explanations).toHaveLength(256);
    expect(trace.explanationsTruncated).toBe(true);
    expect(trace.variableChanges).toHaveLength(256);
    expect(trace.variableChangesTruncated).toBe(true);
  });
});
