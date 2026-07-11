import { describe, expect, it, vi } from "vitest";
import { lowerTupleAssignment, type TupleLoweringContext } from "../src/strategy/pine/tupleLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<TupleLoweringContext> = {}): TupleLoweringContext {
  return {
    bind: vi.fn(),
    checkName: vi.fn(),
    hasUserFunction: () => false,
    inlineUserFunctionTuple: () => [],
    keltner: (_args, band) => ({ k: "kc", band, period: { k: "num", v: 20 }, mult: { k: "num", v: 2 } }),
    numArg: (args, position, _name, fallback) => {
      const expr = args[position]?.value;
      return expr?.t === "num" ? { k: "num", v: expr.v } : fallback ?? { k: "price", field: "close" };
    },
    value: (expr) => expr.t === "num" ? { t: "num", e: { k: "num", v: expr.v } } : { t: "bool", e: { k: "bool", v: true } },
    ...overrides
  };
}

describe("Pine tuple lowering", () => {
  it("binds direct tuple literals as typed values", () => {
    const ctx = context();
    lowerTupleAssignment(ctx, ["value", "ready"], {
      t: "tuplelit", items: [{ t: "num", v: 3 }, { t: "ident", name: "true" }]
    });
    expect(ctx.bind).toHaveBeenNthCalledWith(1, "value", { t: "num", e: { k: "num", v: 3 } });
    expect(ctx.bind).toHaveBeenNthCalledWith(2, "ready", { t: "bool", e: { k: "bool", v: true } });
  });

  it("delegates user-defined tuple returns", () => {
    const tuple = [{ t: "num", e: { k: "num", v: 8 } }] as const;
    const ctx = context({ hasUserFunction: (name) => name === "pair", inlineUserFunctionTuple: () => [...tuple] });
    lowerTupleAssignment(ctx, ["first"], { t: "call", callee: "pair", args: [] });
    expect(ctx.bind).toHaveBeenCalledWith("first", tuple[0]);
  });

  it("builds all three MACD lines with shared parameters", () => {
    const ctx = context();
    const call: PineExpr = { t: "call", callee: "ta.macd", args: [
      { value: { t: "ident", name: "close" } },
      { value: { t: "num", v: 12 } },
      { value: { t: "num", v: 26 } },
      { value: { t: "num", v: 9 } }
    ] };
    lowerTupleAssignment(ctx, ["macd", "signal", "hist"], call);
    expect(vi.mocked(ctx.bind).mock.calls.map(([, value]) => value.t === "num" && value.e.k === "macd" ? value.e.line : "")).toEqual([
      "macd", "signal", "histogram"
    ]);
  });

  it("validates every target name even when the tuple is shorter", () => {
    const ctx = context();
    lowerTupleAssignment(ctx, ["first", "unused"], { t: "tuplelit", items: [{ t: "num", v: 1 }] });
    expect(ctx.checkName).toHaveBeenCalledTimes(2);
    expect(ctx.bind).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unknown tuple-producing calls", () => {
    expect(() => lowerTupleAssignment(context(), ["x"], { t: "call", callee: "vendor.tuple", args: [] })).toThrow("Tuple destructuring is only supported");
  });
});
