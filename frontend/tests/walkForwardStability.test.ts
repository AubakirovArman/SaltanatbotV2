import { describe, expect, it } from "vitest";
import {
  parameterStability,
  walkForward,
  type FoldResult,
  type OptimizeSpec
} from "../src/strategy/optimizer";
import { DEFAULT_CONFIG } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";

const strategy: StrategyIR = {
  name: "walk-forward",
  inputs: [{ name: "threshold", value: 100 }],
  body: [
    { k: "size", mode: "units", value: { k: "num", v: 1 } },
    { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "input", name: "threshold" } } },
    { k: "exit", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "input", name: "threshold" } } }
  ]
};

const candles: Candle[] = Array.from({ length: 60 }, (_, index) => {
  const close = index % 4 < 2 ? 98 + (index % 3) : 103 + (index % 2);
  return { time: index * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 100, source: "Fixture" };
});

const spec: OptimizeSpec = {
  params: [{ name: "threshold", values: [99, 100, 101] }],
  objective: "netProfit",
  trainFrac: 0.7,
  maxCombos: 10
};

describe("anchored/rolling walk-forward and parameter stability", () => {
  it("uses expanding anchored training windows with disjoint OOS folds", () => {
    const anchored = walkForward(strategy, candles, DEFAULT_CONFIG, spec, { folds: 4, mode: "anchored" });
    const repeated = walkForward(strategy, candles, DEFAULT_CONFIG, spec, { folds: 4, mode: "anchored" });

    expect(anchored.mode).toBe("anchored");
    expect(anchored.folds).toHaveLength(4);
    expect(anchored.folds.every((fold) => fold.trainFrom === candles[0].time)).toBe(true);
    expect(anchored.folds.map((fold) => fold.trainTo)).toEqual([...anchored.folds.map((fold) => fold.trainTo)].sort((a, b) => a - b));
    expect(anchored.folds.slice(1).every((fold, index) => fold.testFrom > anchored.folds[index].testTo)).toBe(true);
    expect(anchored.stability.map((item) => item.name)).toEqual(["threshold"]);
    expect(repeated).toEqual(anchored);
  });

  it("keeps rolling windows independent and classifies neighbouring winners", () => {
    const rolling = walkForward(strategy, candles, DEFAULT_CONFIG, spec, { folds: 4, mode: "rolling" });
    expect(rolling.mode).toBe("rolling");
    expect(new Set(rolling.folds.map((fold) => fold.trainFrom)).size).toBeGreaterThan(1);

    const template = rolling.folds[0] as FoldResult;
    const stability = parameterStability([
      { ...template, params: { threshold: 10 } },
      { ...template, fold: 1, params: { threshold: 20 } }
    ]);
    expect(stability[0]).toMatchObject({ min: 10, max: 20, stable: false });
    expect(stability[0].normalizedRange).toBeCloseTo(0.5);
  });
});
