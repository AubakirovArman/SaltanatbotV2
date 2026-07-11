import { describe, expect, it } from "vitest";
import { candlesFromCloses } from "@saltanatbotv2/test-fixtures";
import { evaluateBar, runInit } from "../../backend/src/trading/strategy/evaluator.js";
import { evaluateBar as evaluateCoreBar } from "@saltanatbotv2/strategy-core";
import type { StrategyIR as BackendStrategyIR } from "../../backend/src/trading/strategy/ir.js";
import * as backendTa from "../../backend/src/trading/strategy/ta.js";
import { previewStrategy } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import * as frontendTa from "../src/strategy/ta";

/**
 * A stateful fixture intentionally exercises init, numeric/boolean variables,
 * an indicator, nested control flow and markers across both runtime adapters.
 */
const parityIR: StrategyIR = {
  name: "runtime-parity",
  inputs: [{ name: "threshold", value: 100 }],
  init: [{ k: "setvar", name: "bars", value: { k: "num", v: 0 } }],
  body: [
    {
      k: "setvar",
      name: "bars",
      value: { k: "arith", op: "+", a: { k: "var", name: "bars" }, b: { k: "num", v: 1 } }
    },
    {
      k: "setvarb",
      name: "hot",
      value: {
        k: "logic",
        op: "and",
        a: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "input", name: "threshold" } },
        b: { k: "compare", op: ">=", a: { k: "var", name: "bars" }, b: { k: "num", v: 3 } }
      }
    },
    {
      k: "if",
      cond: { k: "varb", name: "hot" },
      then: [
        {
          k: "entry",
          direction: "long",
          when: {
            k: "compare",
            op: ">",
            a: { k: "price", field: "close" },
            b: { k: "ma", kind: "sma", period: { k: "num", v: 2 }, source: { k: "price", field: "close" } }
          }
        },
        { k: "marker", dir: "up", label: "hot", when: { k: "bool", v: true } }
      ],
      else: [{ k: "exit", when: { k: "bool", v: true } }]
    }
  ]
};

const candles = candlesFromCloses([98, 99, 101, 104, 103, 97, 102, 106]);

interface SignalCounts {
  buy: number;
  sell: number;
  exit: number;
}

function emptyCounts(): SignalCounts {
  return { buy: 0, sell: 0, exit: 0 };
}

describe("frontend preview/backend evaluator parity", () => {
  it("uses the same strategy-core TA implementation in browser and server adapters", () => {
    expect(frontendTa.sma).toBe(backendTa.sma);
    expect(frontendTa.atr).toBe(backendTa.atr);
    expect(frontendTa.sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
  });

  it("exposes the strategy-core evaluator through the backend compatibility facade", () => {
    expect(evaluateBar).toBe(evaluateCoreBar);
  });

  it("emits identical signal counts on every bar for stateful IR", () => {
    const preview = previewStrategy(parityIR, candles);
    const previewByTime = new Map<number, SignalCounts>();
    for (const signal of preview.signals) {
      const counts = previewByTime.get(signal.time) ?? emptyCounts();
      counts[signal.kind] += 1;
      previewByTime.set(signal.time, counts);
    }

    const backendIR = parityIR as BackendStrategyIR;
    const vars = new Map<string, number>();
    runInit(backendIR, candles, vars);
    const backendByTime = new Map<number, SignalCounts>();
    for (let index = 0; index < candles.length; index += 1) {
      const intents = evaluateBar(backendIR, candles, index, vars);
      const counts = emptyCounts();
      if (intents.entry === "long") counts.buy += 1;
      if (intents.entry === "short") counts.sell += 1;
      if (intents.exit) counts.exit += 1;
      for (const marker of intents.markers) counts[marker.dir === "up" ? "buy" : "sell"] += 1;
      // previewStrategy deliberately suppresses chart markers on the first bar,
      // while still executing its state updates there.
      if (index >= 1 && (counts.buy || counts.sell || counts.exit)) backendByTime.set(candles[index].time, counts);
    }

    expect(Object.fromEntries(previewByTime)).toEqual(Object.fromEntries(backendByTime));
    expect(vars.get("bars")).toBe(candles.length);
  });
});
