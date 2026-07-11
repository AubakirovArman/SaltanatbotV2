import { describe, expect, it, vi } from "vitest";
import type { NumExpr } from "../src/strategy/ir";
import { lowerNumericExpression, type NumericExpressionLoweringContext } from "../src/strategy/pine/numericExpressionLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<NumericExpressionLoweringContext> = {}): NumericExpressionLoweringContext {
  let ctx: NumericExpressionLoweringContext;
  ctx = {
    bool: () => ({ k: "bool", v: true }),
    hasBoundValue: () => false,
    isIntegerLike: (expr) => expr.t === "num" && Number.isInteger(expr.v),
    isMutableNumber: () => false,
    num: (expr) => lowerNumericExpression(ctx, expr),
    resolveCall: () => ({ k: "num", v: 7 }),
    resolveField: () => ({ k: "num", v: 0 }),
    resolveIdentifier: (name) => name === "bar_index" ? { k: "barindex" } : { k: "price", field: name === "high" ? "high" : "close" },
    resolveMethod: () => ({ k: "num", v: 0 }),
    resolveSwitch: () => ({ k: "num", v: 0 }),
    warnOnce: vi.fn(),
    ...overrides
  };
  return ctx;
}

describe("Pine numeric expression lowering", () => {
  it("lowers arithmetic and reports Pine integer-division divergence", () => {
    const ctx = context();
    const expr: PineExpr = { t: "binary", op: "/", a: { t: "num", v: 7 }, b: { t: "num", v: 2 } };
    expect(lowerNumericExpression(ctx, expr)).toEqual({ k: "arith", op: "/", a: { k: "num", v: 7 }, b: { k: "num", v: 2 } });
    expect(ctx.warnOnce).toHaveBeenCalledWith("intdiv", expect.stringContaining("integer division"));
  });

  it("maps raw-price history to compact static and dynamic IR nodes", () => {
    const ctx = context();
    expect(lowerNumericExpression(ctx, { t: "index", base: { t: "ident", name: "close" }, offset: { t: "num", v: 2 } })).toEqual({
      k: "price", field: "close", offset: 2
    });
    expect(lowerNumericExpression(ctx, { t: "index", base: { t: "ident", name: "high" }, offset: { t: "ident", name: "offset" } })).toEqual({
      k: "histn", field: "high", offset: { k: "price", field: "close" }
    });
  });

  it("supports exactly the previous value for mutable scalar state", () => {
    const ctx = context({ isMutableNumber: (name) => name === "counter" });
    expect(lowerNumericExpression(ctx, { t: "index", base: { t: "ident", name: "counter" }, offset: { t: "num", v: 1 } })).toEqual({
      k: "varprev", name: "counter"
    });
    expect(() => lowerNumericExpression(ctx, { t: "index", base: { t: "ident", name: "counter" }, offset: { t: "num", v: 2 } })).toThrow("Only the previous bar");
  });

  it("fails closed for dynamic history on a computed series", () => {
    const computed: NumExpr = { k: "ma", kind: "sma", period: { k: "num", v: 10 }, source: { k: "price", field: "close" } };
    const ctx = context({ resolveCall: () => computed });
    expect(() => lowerNumericExpression(ctx, {
      t: "index",
      base: { t: "call", callee: "ta.sma", args: [] },
      offset: { t: "ident", name: "offset" }
    })).toThrow("dynamic history offset");
  });
});
