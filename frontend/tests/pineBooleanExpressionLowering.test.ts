import { describe, expect, it, vi } from "vitest";
import { lowerBooleanExpression, type BooleanExpressionLoweringContext } from "../src/strategy/pine/booleanExpressionLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<BooleanExpressionLoweringContext> = {}): BooleanExpressionLoweringContext {
  let ctx: BooleanExpressionLoweringContext;
  ctx = {
    bool: (expr) => lowerBooleanExpression(ctx, expr),
    isBooleanExpression: (expr) => expr.t === "ident" && ["true", "false", "ready"].includes(expr.name),
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    resolveCall: () => ({ k: "bool", v: true }),
    resolveIdentifier: (name) => ({ k: "bool", v: name !== "false" }),
    resolveString: (expr) => expr.t === "str" ? expr.v : undefined,
    resolveSwitch: () => ({ k: "bool", v: false }),
    warnOnce: vi.fn(),
    ...overrides
  };
  return ctx;
}

describe("Pine boolean expression lowering", () => {
  it("maps comparisons with na to explicit isna conditions", () => {
    const expr: PineExpr = { t: "binary", op: "!=", a: { t: "ident", name: "close" }, b: { t: "ident", name: "na" } };
    expect(lowerBooleanExpression(context(), expr)).toEqual({ k: "not", a: { k: "isna", a: { k: "price", field: "close" } } });
  });

  it("represents boolean equality without numeric coercion", () => {
    const expr: PineExpr = { t: "binary", op: "==", a: { t: "ident", name: "ready" }, b: { t: "ident", name: "true" } };
    expect(lowerBooleanExpression(context(), expr)).toMatchObject({
      k: "logic",
      op: "or",
      a: { k: "logic", op: "and" },
      b: { k: "logic", op: "and" }
    });
  });

  it("constant-folds static string selectors", () => {
    const expr: PineExpr = { t: "binary", op: "==", a: { t: "str", v: "Long" }, b: { t: "str", v: "Short" } };
    expect(lowerBooleanExpression(context(), expr)).toEqual({ k: "bool", v: false });
  });

  it("shifts boolean series only by non-negative literal history offsets", () => {
    const ctx = context();
    expect(lowerBooleanExpression(ctx, { t: "index", base: { t: "ident", name: "ready" }, offset: { t: "num", v: 2 } })).toEqual({
      k: "bool", v: true
    });
    expect(() => lowerBooleanExpression(ctx, {
      t: "index", base: { t: "ident", name: "ready" }, offset: { t: "ident", name: "offset" }
    })).toThrow("non-negative integer literal");
  });

  it("lowers boolean ternaries to guarded logical branches", () => {
    const expr: PineExpr = {
      t: "ternary",
      cond: { t: "ident", name: "ready" },
      a: { t: "ident", name: "true" },
      b: { t: "ident", name: "false" }
    };
    expect(lowerBooleanExpression(context(), expr)).toMatchObject({ k: "logic", op: "or" });
  });
});
