import { describe, expect, it } from "vitest";
import { collectReassigned, constBool, isBoolExpr, isCollectionCallName, isCollectionConstructor, isObjectConstructor, literalColorByte } from "../src/strategy/pine/semanticHelpers";
import type { BoolExpr } from "../src/strategy/ir";
import type { PineExpr, PineStmt } from "../src/strategy/pine/parser";

describe("Pine semantic helpers", () => {
  it("folds constant boolean trees without guessing dynamic comparisons", () => {
    const folded: BoolExpr = { k: "logic", op: "and", a: { k: "bool", v: true }, b: { k: "not", a: { k: "bool", v: false } } };
    expect(constBool(folded)).toBe(true);
    expect(constBool({ k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 1 } })).toBeUndefined();
  });

  it("clamps literal RGB components and rejects dynamic values", () => {
    expect(literalColorByte({ t: "num", v: 300 })).toBe(255);
    expect(literalColorByte({ t: "unary", op: "-", a: { t: "num", v: 3 } })).toBe(0);
    expect(literalColorByte({ t: "ident", name: "dynamic" })).toBeUndefined();
  });

  it("separates collection constructors, methods and user objects", () => {
    expect(isCollectionConstructor("array.new_float")).toBe(true);
    expect(isCollectionCallName("items.push")).toBe(true);
    expect(isObjectConstructor("TradeState.new")).toBe(true);
    expect(isObjectConstructor("line.new")).toBe(false);
  });

  it("finds reassignments recursively but not unrelated declarations", () => {
    const statements = [
      { t: "assign", name: "a", value: { t: "num", v: 1 }, declaredVar: false },
      { t: "if", clauses: [{ cond: { t: "ident", name: "true" }, body: [{ t: "reassign", name: "counter", op: "+=", value: { t: "num", v: 1 } }] }] }
    ] as PineStmt[];
    expect([...collectReassigned(statements)]).toEqual(["counter"]);
  });

  it("detects boolean series through syntax and bound semantic values", () => {
    expect(isBoolExpr({ t: "binary", op: ">", a: { t: "ident", name: "close" }, b: { t: "num", v: 1 } }, new Set(), new Map())).toBe(true);
    const bound = new Map([["ready", { t: "bool", e: { k: "bool", v: true } } as const]]);
    expect(isBoolExpr({ t: "ident", name: "ready" } as PineExpr, new Set(), bound)).toBe(true);
  });
});
