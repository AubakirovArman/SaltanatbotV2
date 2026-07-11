import { describe, expect, it, vi } from "vitest";
import type { NumExpr } from "../src/strategy/ir";
import { lowerBooleanCall, type BooleanCallLoweringContext } from "../src/strategy/pine/booleanCallLowering";
import type { PineArg, PineExpr } from "../src/strategy/pine/parser";

const argument = (value: PineExpr): PineArg => ({ value });
const call = (callee: string, args: PineArg[] = []): Extract<PineExpr, { t: "call" }> => ({ t: "call", callee, args });

function context(overrides: Partial<BooleanCallLoweringContext> = {}): BooleanCallLoweringContext {
  const numeric = (expr: PineExpr): NumExpr => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" };
  return {
    bool: (expr) => ({ k: "bool", v: expr.t !== "ident" || expr.name !== "false" }),
    hasUserFunction: () => false,
    inlineUserFunction: () => ({ t: "bool", e: { k: "bool", v: true } }),
    num: numeric,
    numArg: (args, position) => args[position] ? numeric(args[position].value) : { k: "num", v: 0 },
    numCall: () => ({ k: "num", v: 1 }),
    securityVal: () => ({ t: "num", e: { k: "price", field: "close" } }),
    seriesArg: (args, position) => args[position] ? numeric(args[position].value) : { k: "price", field: "close" },
    timeCall: () => ({ k: "time" }),
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine boolean call lowering", () => {
  it("maps crossover calls to typed cross conditions", () => {
    expect(lowerBooleanCall(context(), call("ta.crossover", [
      argument({ t: "ident", name: "close" }),
      argument({ t: "num", v: 10 })
    ]))).toEqual({ k: "cross", dir: "above", a: { k: "price", field: "close" }, b: { k: "num", v: 10 } });
  });

  it("uses the full previous window for multi-bar rising checks", () => {
    expect(lowerBooleanCall(context(), call("ta.rising", [
      argument({ t: "ident", name: "close" }),
      argument({ t: "num", v: 3 })
    ]))).toMatchObject({
      k: "compare",
      op: ">",
      b: { k: "extreme", kind: "highest", period: { k: "num", v: 3 }, source: { k: "shift", offset: 1 } }
    });
  });

  it("preserves boolean values returned by request.security", () => {
    const ctx = context({ securityVal: () => ({ t: "bool", e: { k: "bool", v: true } }) });
    expect(lowerBooleanCall(ctx, call("request.security"))).toEqual({ k: "bool", v: true });
  });

  it("makes unsupported timeframe boundaries visibly conservative", () => {
    const ctx = context();
    expect(lowerBooleanCall(ctx, call("timeframe.change"))).toEqual({ k: "bool", v: false });
    expect(ctx.warnOnce).toHaveBeenCalledWith("tfchange", expect.stringContaining("approximated as false"));
  });
});
