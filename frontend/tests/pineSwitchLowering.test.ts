import { describe, expect, it, vi } from "vitest";
import { lowerSwitchStatement, lowerSwitchValue, type SwitchLoweringContext } from "../src/strategy/pine/switchLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<SwitchLoweringContext> = {}): SwitchLoweringContext {
  return {
    bool: (expr) => ({ k: "bool", v: expr.t !== "ident" || expr.name !== "false" }),
    expressionStatement: (expr) => [{ k: "alert", message: expr.t === "str" ? expr.v : "action" }],
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    string: (expr) => expr.t === "str" ? expr.v : undefined,
    value: (expr) => expr.t === "ident" && ["true", "false"].includes(expr.name)
      ? { t: "bool", e: { k: "bool", v: expr.name === "true" } }
      : { t: "num", e: expr.t === "num" ? { k: "num", v: expr.v } : { k: "num", v: 0 } },
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine switch lowering", () => {
  it("selects a static string arm during import", () => {
    const expr: Extract<PineExpr, { t: "switch" }> = {
      t: "switch",
      subject: { t: "str", v: "Short" },
      arms: [
        { match: { t: "str", v: "Long" }, body: { t: "str", v: "buy" } },
        { match: { t: "str", v: "Short" }, body: { t: "str", v: "sell" } },
        { body: { t: "str", v: "hold" } }
      ]
    };
    expect(lowerSwitchValue(context(), expr)).toEqual({ t: "str", v: "sell" });
  });

  it("uses a visible conservative fallback for numeric switches without default", () => {
    const ctx = context();
    const expr: Extract<PineExpr, { t: "switch" }> = {
      t: "switch",
      subject: { t: "num", v: 2 },
      arms: [{ match: { t: "num", v: 1 }, body: { t: "num", v: 10 } }]
    };
    expect(lowerSwitchValue(ctx, expr)).toMatchObject({ t: "num", e: { k: "cond", b: { k: "num", v: 0 } } });
    expect(ctx.warnOnce).toHaveBeenCalledWith("switchdef", expect.stringContaining("without a default"));
  });

  it("builds guarded logical branches for boolean results", () => {
    const expr: Extract<PineExpr, { t: "switch" }> = {
      t: "switch",
      arms: [
        { match: { t: "ident", name: "ready" }, body: { t: "ident", name: "true" } },
        { body: { t: "ident", name: "false" } }
      ]
    };
    expect(lowerSwitchValue(context(), expr)).toMatchObject({ t: "bool", e: { k: "logic", op: "or" } });
  });

  it("maps statement switches to an if/elif/else chain", () => {
    const expr: Extract<PineExpr, { t: "switch" }> = {
      t: "switch",
      subject: { t: "num", v: 2 },
      arms: [
        { match: { t: "num", v: 1 }, body: { t: "str", v: "one" } },
        { match: { t: "num", v: 2 }, body: { t: "str", v: "two" } },
        { body: { t: "str", v: "other" } }
      ]
    };
    expect(lowerSwitchStatement(context(), expr)).toMatchObject([{
      k: "if",
      then: [{ k: "alert", message: "one" }],
      elifs: [{ then: [{ k: "alert", message: "two" }] }],
      else: [{ k: "alert", message: "other" }]
    }]);
  });
});
