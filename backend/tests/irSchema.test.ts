import { describe, expect, it } from "vitest";
import { parseStrategyIR } from "../src/trading/strategy/irSchema.js";

const validIR = {
  name: "EMA cross",
  inputs: [{ name: "fast", value: 9 }],
  body: [
    {
      k: "entry",
      direction: "long",
      when: {
        k: "cross",
        dir: "above",
        a: { k: "ma", kind: "ema", period: { k: "input", name: "fast" }, source: { k: "price", field: "close" } },
        b: { k: "ma", kind: "ema", period: { k: "num", v: 21 }, source: { k: "price", field: "close" } }
      }
    },
    { k: "setvar", name: "count", value: { k: "arith", op: "^", a: { k: "num", v: 2 }, b: { k: "num", v: 3 } } }
  ]
};

describe("parseStrategyIR", () => {
  it("accepts a well-formed IR (including the new ^ op)", () => {
    const result = parseStrategyIR(validIR);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown node kind", () => {
    const result = parseStrategyIR({ name: "x", inputs: [], body: [{ k: "eval", code: "steal()" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown extra fields (strict)", () => {
    const result = parseStrategyIR({
      name: "x",
      inputs: [],
      body: [{ k: "exit", when: { k: "bool", v: true }, sneaky: 1 }]
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a future IR version this backend can't run", () => {
    const result = parseStrategyIR({ ...validIR, v: 999 });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object / missing body", () => {
    expect(parseStrategyIR("nope").ok).toBe(false);
    expect(parseStrategyIR({ name: "x", inputs: [] }).ok).toBe(false);
  });

  it("rejects pathologically deep nesting without throwing", () => {
    let expr: unknown = { k: "num", v: 1 };
    for (let i = 0; i < 200; i += 1) expr = { k: "unary", op: "abs", a: expr };
    const result = parseStrategyIR({ name: "x", inputs: [], body: [{ k: "plot", value: expr, label: "l", color: "#fff" }] });
    expect(result.ok).toBe(false);
  });

  it("accepts an if node with else-if and else branches", () => {
    const result = parseStrategyIR({
      name: "if-else",
      inputs: [],
      body: [
        {
          k: "if",
          cond: { k: "bool", v: true },
          then: [{ k: "exit", when: { k: "bool", v: true } }],
          elifs: [{ cond: { k: "bool", v: false }, then: [{ k: "marker", dir: "up", label: "a", when: { k: "bool", v: true } }] }],
          else: [{ k: "setvar", name: "x", value: { k: "num", v: 1 } }]
        }
      ]
    });
    expect(result.ok).toBe(true);
  });

  it("accepts repeat and while loop nodes; rejects an over-cap while", () => {
    const ok = parseStrategyIR({
      name: "loops",
      inputs: [],
      body: [
        { k: "repeat", count: { k: "num", v: 10 }, body: [{ k: "setvar", name: "n", value: { k: "num", v: 1 } }] },
        { k: "while", cond: { k: "bool", v: true }, cap: 100, body: [{ k: "setvar", name: "n", value: { k: "num", v: 2 } }] }
      ]
    });
    expect(ok.ok).toBe(true);
    const bad = parseStrategyIR({ name: "x", inputs: [], body: [{ k: "while", cond: { k: "bool", v: true }, cap: 999999, body: [] }] });
    expect(bad.ok).toBe(false);
  });

  it("accepts a legacy IR with no version field", () => {
    const { v, ...legacy } = validIR as typeof validIR & { v?: number };
    expect(parseStrategyIR(legacy).ok).toBe(true);
  });
});
