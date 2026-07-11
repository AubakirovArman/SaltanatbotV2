import { describe, expect, it, vi } from "vitest";
import { lowerAssignment, lowerMutableAssignment, type AssignmentLoweringContext } from "../src/strategy/pine/assignmentLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<AssignmentLoweringContext> = {}): AssignmentLoweringContext {
  return {
    addBooleanVariable: vi.fn(),
    addDrawingHandle: vi.fn(),
    addInit: vi.fn(),
    addNumericVariable: vi.fn(),
    addOpaqueVariable: vi.fn(),
    bind: vi.fn(),
    bindColor: vi.fn(),
    bindDrawingCollection: vi.fn(),
    bindPlotHandle: vi.fn(),
    bool: () => ({ k: "bool", v: true }),
    checkName: vi.fn(),
    color: () => "#00ff00",
    expressionStatement: () => [{ k: "plot", value: { k: "price", field: "close" }, label: "Close", color: "#fff" }],
    isBooleanExpression: (expr) => expr.t === "ident" && expr.name === "ready",
    isBooleanVariable: () => false,
    isColorExpression: () => false,
    isDrawingCollection: () => false,
    isNumericVariable: () => false,
    isReassigned: () => false,
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    registerCollection: vi.fn(),
    registerInput: vi.fn(),
    storageName: (name) => name.replaceAll(".", "_"),
    string: (expr) => expr.t === "str" ? expr.v : undefined,
    value: (expr) => expr.t === "ident" && expr.name === "ready"
      ? { t: "bool", e: { k: "bool", v: true } }
      : expr.t === "str"
        ? { t: "str", v: expr.v }
        : { t: "num", e: expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" } },
    warn: vi.fn(),
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine assignment lowering", () => {
  it("binds immutable values in the compile-time environment", () => {
    const ctx = context();
    expect(lowerAssignment(ctx, "length", { t: "num", v: 20 }, false)).toEqual([]);
    expect(ctx.bind).toHaveBeenCalledWith("length", { t: "num", e: { k: "num", v: 20 } });
  });

  it("registers inputs and plot handles before scalar classification", () => {
    const inputCtx = context();
    lowerAssignment(inputCtx, "period", { t: "call", callee: "input.int", args: [] }, false);
    expect(inputCtx.registerInput).toHaveBeenCalledWith("period", expect.objectContaining({ callee: "input.int" }));

    const plotCtx = context();
    const result = lowerAssignment(plotCtx, "pricePlot", { t: "call", callee: "plot", args: [] }, false);
    expect(result[0]).toMatchObject({ k: "plot" });
    expect(plotCtx.bindPlotHandle).toHaveBeenCalledWith("pricePlot", expect.objectContaining({ k: "plot" }));
  });

  it("moves declared numeric and boolean vars into one-time init", () => {
    const numeric = context();
    lowerAssignment(numeric, "counter", { t: "num", v: 1 }, true);
    expect(numeric.addInit).toHaveBeenCalledWith({ k: "setvar", name: "counter", value: { k: "num", v: 1 } });

    const boolean = context();
    lowerAssignment(boolean, "enabled", { t: "ident", name: "ready" }, true);
    expect(boolean.addBooleanVariable).toHaveBeenCalledWith("enabled");
    expect(boolean.addInit).toHaveBeenCalledWith({ k: "setvar", name: "enabled", value: { k: "num", v: 1 } });
  });

  it("maps mutable numeric ternaries losslessly to if/else setvars", () => {
    const ctx = context({ isReassigned: (name) => name === "level" });
    const value: Extract<PineExpr, { t: "ternary" }> = {
      t: "ternary", cond: { t: "ident", name: "ready" }, a: { t: "num", v: 10 }, b: { t: "num", v: 5 }
    };
    expect(lowerAssignment(ctx, "level", value, false)).toEqual([{
      k: "if",
      cond: { k: "bool", v: true },
      then: [{ k: "setvar", name: "level", value: { k: "num", v: 10 } }],
      else: [{ k: "setvar", name: "level", value: { k: "num", v: 5 } }]
    }]);
  });

  it("preserves mutable variable types and fails on mixed assignments", () => {
    const boolean = context({ isBooleanVariable: (name) => name === "ready" });
    expect(lowerMutableAssignment(boolean, "ready", { t: "ident", name: "ready" })).toEqual([{
      k: "setvarb", name: "ready", value: { k: "bool", v: true }
    }]);
    expect(() => lowerMutableAssignment(boolean, "ready", { t: "num", v: 1 })).toThrow("mixes boolean and numeric");
  });

  it("freezes mutable strings visibly and records opaque objects", () => {
    const text = context();
    expect(lowerMutableAssignment(text, "mode", { t: "str", v: "Long" })).toEqual([]);
    expect(text.warnOnce).toHaveBeenCalledWith("mutstr", expect.stringContaining("fixed"));

    const opaque = context();
    lowerAssignment(opaque, "state", { t: "call", callee: "TradeState.new", args: [] }, false);
    expect(opaque.addOpaqueVariable).toHaveBeenCalledWith("state");
  });
});
