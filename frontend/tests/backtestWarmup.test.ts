import { describe, expect, it } from "vitest";
import { DYNAMIC_WARMUP_BARS, estimateWarmupBars } from "../src/strategy/backtest/warmup";
import type { StrategyIR } from "../src/strategy/ir";

function strategy(body: StrategyIR["body"], inputs: StrategyIR["inputs"] = []): StrategyIR {
  return { name: "warmup", inputs, body };
}

describe("backtest warm-up analysis", () => {
  it("walks elif/else and every bounded loop body", () => {
    const ir = strategy([
      {
        k: "if",
        cond: { k: "bool", v: false },
        then: [],
        else: [
          {
            k: "for",
            var: "i",
            from: { k: "num", v: 0 },
            to: { k: "num", v: 1 },
            step: { k: "num", v: 1 },
            cap: 2,
            body: [
              {
                k: "plot",
                label: "nested",
                color: "#fff",
                value: {
                  k: "ma",
                  kind: "sma",
                  period: { k: "input", name: "length" },
                  source: { k: "price", field: "close" }
                }
              }
            ]
          }
        ]
      }
    ], [{ name: "length", value: 50 }]);

    expect(estimateWarmupBars(ir)).toBe(50);
  });

  it("adds explicit shifts to their source lookback", () => {
    const ir = strategy([
      {
        k: "plot",
        label: "shifted",
        color: "#fff",
        value: {
          k: "shift",
          offset: 5,
          src: { k: "rsi", period: { k: "num", v: 14 }, source: { k: "price", field: "close" } }
        }
      }
    ]);

    expect(estimateWarmupBars(ir)).toBe(19);
  });

  it("uses a conservative floor without hiding larger known periods", () => {
    const ir = strategy([
      { k: "plot", label: "known", color: "#fff", value: { k: "ma", kind: "sma", period: { k: "num", v: 500 }, source: { k: "price", field: "close" } } },
      { k: "plot", label: "dynamic", color: "#fff", value: { k: "histn", field: "close", offset: { k: "var", name: "offset" } } }
    ]);

    expect(DYNAMIC_WARMUP_BARS).toBe(200);
    expect(estimateWarmupBars(ir)).toBe(500);
  });

  it("does not treat bar_index or cumulative VWAP as unavailable history", () => {
    const ir = strategy([
      { k: "plot", label: "index", color: "#fff", value: { k: "barindex" } },
      { k: "plot", label: "vwap", color: "#fff", value: { k: "vwap" } }
    ]);

    expect(estimateWarmupBars(ir)).toBe(1);
  });
});
