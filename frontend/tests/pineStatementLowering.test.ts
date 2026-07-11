import { describe, expect, it, vi } from "vitest";
import { lowerStatement, type StatementLoweringContext } from "../src/strategy/pine/statementLowering";
import type { PineStmt } from "../src/strategy/pine/parser";

function context(overrides: Partial<StatementLoweringContext> = {}): StatementLoweringContext {
  let ctx: StatementLoweringContext;
  ctx = {
    assign: (name) => [{ k: "alert", message: `assign:${name}` }],
    bool: (expr) => expr.t === "ident" && expr.name === "true"
      ? { k: "bool", v: true }
      : expr.t === "ident" && expr.name === "false"
        ? { k: "bool", v: false }
        : { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 0 } },
    checkName: vi.fn(),
    expressionStatement: () => [{ k: "alert", message: "effect" }],
    lower: (statement) => lowerStatement(ctx, statement),
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    registerFunction: vi.fn(),
    registerLoopVariable: vi.fn(),
    setMutable: (_name, value) => [{ k: "setvar", name: "counter", value: value.t === "binary" ? { k: "num", v: 2 } : { k: "num", v: 1 } }],
    tuple: () => [],
    warn: vi.fn(),
    warnOnce: vi.fn(),
    ...overrides
  };
  return ctx;
}

describe("Pine statement lowering", () => {
  it("desugars compound reassignment before delegating mutable state", () => {
    const setMutable = vi.fn(() => []);
    lowerStatement(context({ setMutable }), { t: "reassign", name: "counter", op: "+=", value: { t: "num", v: 1 } });
    expect(setMutable).toHaveBeenCalledWith("counter", {
      t: "binary", op: "+", a: { t: "ident", name: "counter" }, b: { t: "num", v: 1 }
    });
  });

  it("folds constant if clauses while retaining dynamic branches", () => {
    const statement: PineStmt = { t: "if", clauses: [
      { cond: { t: "ident", name: "false" }, body: [{ t: "expr", value: { t: "num", v: 0 } }] },
      { cond: { t: "ident", name: "ready" }, body: [{ t: "expr", value: { t: "num", v: 1 } }] },
      { cond: undefined, body: [{ t: "expr", value: { t: "num", v: 2 } }] }
    ] };
    expect(lowerStatement(context(), statement)).toMatchObject([{
      k: "if",
      then: [{ k: "alert", message: "effect" }],
      else: [{ k: "alert", message: "effect" }]
    }]);
  });

  it("bounds for and while loops and registers scalar loop variables", () => {
    const ctx = context();
    expect(lowerStatement(ctx, {
      t: "for", var: "i", from: { t: "num", v: 0 }, to: { t: "num", v: 10 }, body: []
    })).toMatchObject([{ k: "for", var: "i", step: { k: "num", v: 1 }, cap: 10_000 }]);
    expect(ctx.registerLoopVariable).toHaveBeenCalledWith("i");
    expect(lowerStatement(ctx, { t: "while", cond: { t: "ident", name: "ready" }, body: [] })).toMatchObject([{ k: "while", cap: 1000 }]);
  });

  it("registers functions after validating their names", () => {
    const ctx = context();
    const definition = { name: "double", params: [], body: [], ret: { t: "num", v: 2 } } as const;
    lowerStatement(ctx, { t: "func", def: definition });
    expect(ctx.checkName).toHaveBeenCalledWith("double");
    expect(ctx.registerFunction).toHaveBeenCalledWith(definition);
  });

  it("classifies unsupported statements with stable warnings", () => {
    const ctx = context();
    expect(lowerStatement(ctx, { t: "unsupported", what: "collection declaration", line: 4 })).toEqual([]);
    expect(ctx.warnOnce).toHaveBeenCalledWith("collections", expect.stringContaining("unsupported collection operations"));
    lowerStatement(ctx, { t: "unsupported", what: "mystery", line: 9 });
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("line 9"));
  });
});
