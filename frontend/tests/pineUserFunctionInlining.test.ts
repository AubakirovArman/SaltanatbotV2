import { describe, expect, it, vi } from "vitest";
import type { PineExpr, PineFuncDef } from "../src/strategy/pine/parser";
import type { PineValue } from "../src/strategy/pine/semanticHelpers";
import {
  inlineUserFunction,
  inlineUserFunctionSafely,
  inlineUserFunctionTuple,
  type UserFunctionInliningContext,
  type UserFunctionInliningState
} from "../src/strategy/pine/userFunctionInlining";

function state(functions: Record<string, PineFuncDef>, environment = new Map<string, PineValue>()): UserFunctionInliningState {
  return {
    environment,
    functions: new Map(Object.entries(functions)),
    inlining: new Set(),
    scope: (work) => {
      const saved = new Map(environment);
      try {
        return work();
      } finally {
        environment.clear();
        for (const [name, value] of saved) environment.set(name, value);
      }
    }
  };
}

function context(current: UserFunctionInliningState): UserFunctionInliningContext {
  const ctx: UserFunctionInliningContext = {
    value: (expr: PineExpr): PineValue => {
      if (expr.t === "num") return { t: "num", e: { k: "num", v: expr.v } };
      if (expr.t === "ident") return current.environment.get(expr.name) ?? { t: "bool", e: { k: "bool", v: expr.name === "true" } };
      if (expr.t === "call") return inlineUserFunction(current, ctx, expr.callee, expr.args);
      throw new Error(`unexpected ${expr.t}`);
    },
    warnOnce: vi.fn()
  };
  return ctx;
}

describe("Pine user-function inlining", () => {
  it("binds arguments by value and restores the caller scope", () => {
    const environment = new Map<string, PineValue>([["x", { t: "num", e: { k: "num", v: 99 } }]]);
    const current = state({ identity: { name: "identity", params: [{ name: "x" }], body: [], ret: { t: "ident", name: "x" } } }, environment);
    expect(inlineUserFunction(current, context(current), "identity", [{ value: { t: "num", v: 3 } }])).toEqual({ t: "num", e: { k: "num", v: 3 } });
    expect(environment.get("x")).toEqual({ t: "num", e: { k: "num", v: 99 } });
    expect(current.inlining.size).toBe(0);
  });

  it("supports defaults, named arguments and immutable return locals", () => {
    const definition: PineFuncDef = {
      name: "pick",
      params: [{ name: "value", def: { t: "num", v: 5 } }],
      body: [{ t: "assign", name: "result", value: { t: "ident", name: "value" }, declaredVar: false }]
    };
    const current = state({ pick: definition });
    expect(inlineUserFunction(current, context(current), "pick", [])).toEqual({ t: "num", e: { k: "num", v: 5 } });
    expect(inlineUserFunction(current, context(current), "pick", [{ name: "value", value: { t: "num", v: 8 } }])).toEqual({ t: "num", e: { k: "num", v: 8 } });
    expect(current.environment.has("result")).toBe(false);
  });

  it("returns typed tuple elements for destructuring", () => {
    const current = state({ pair: { name: "pair", params: [], body: [], ret: { t: "tuplelit", items: [{ t: "num", v: 1 }, { t: "num", v: 2 }] } } });
    expect(inlineUserFunctionTuple(current, context(current), "pair", [])).toEqual([
      { t: "num", e: { k: "num", v: 1 } },
      { t: "num", e: { k: "num", v: 2 } }
    ]);
  });

  it("rejects recursion and always clears the inlining guard", () => {
    const current = state({ recurse: { name: "recurse", params: [], body: [], ret: { t: "call", callee: "recurse", args: [] } } });
    expect(() => inlineUserFunction(current, context(current), "recurse", [])).toThrow("Recursive function");
    expect(current.inlining.size).toBe(0);
  });

  it("degrades side-effecting helper functions to false with a warning", () => {
    const current = state({ helper: {
      name: "helper",
      params: [],
      body: [{ t: "if", clauses: [{ cond: { t: "ident", name: "true" }, body: [] }] }]
    } });
    const ctx = context(current);
    expect(inlineUserFunctionSafely(current, ctx, "helper", [])).toEqual({ t: "bool", e: { k: "bool", v: false } });
    expect(ctx.warnOnce).toHaveBeenCalledWith("sidefxfn", expect.stringContaining("skipped"));
  });
});
