import { describe, expect, it, vi } from "vitest";
import type { NumExpr } from "../src/strategy/ir";
import { PineConvertError } from "../src/strategy/pine/errors";
import { lowerNumericCall, type NumericCallLoweringContext } from "../src/strategy/pine/numericCallLowering";
import type { PineArg, PineExpr } from "../src/strategy/pine/parser";

const argument = (value: PineExpr, name?: string): PineArg => ({ value, name });
const call = (callee: string, args: PineArg[]): Extract<PineExpr, { t: "call" }> => ({ t: "call", callee, args });

function context(overrides: Partial<NumericCallLoweringContext> = {}): NumericCallLoweringContext {
  const numeric = (expr: PineExpr): NumExpr => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" };
  const valueAt = (args: PineArg[], position: number, fallback: NumExpr = { k: "num", v: 0 }) => args[position] ? numeric(args[position].value) : fallback;
  return {
    bool: () => ({ k: "bool", v: true }),
    collectionCallNum: () => ({ k: "num", v: 0 }),
    constPositiveInt: (_value, fallback) => fallback,
    contextString: () => undefined,
    hma: (source) => source,
    kcNode: () => ({ k: "num", v: 0 }),
    literalArg: (_args, _position, _name, _fn, fallback) => fallback,
    num: numeric,
    numArg: (args, position, _name, fallback) => valueAt(args, position, fallback),
    opaqueNum: () => ({ k: "num", v: 0 }),
    securityVal: () => ({ t: "num", e: { k: "price", field: "close" } }),
    seriesArg: (args, position) => valueAt(args, position),
    strVal: (expr) => expr.t === "str" ? expr.v : undefined,
    swma: (source) => source,
    timeCall: () => ({ k: "num", v: 0 }),
    trueRange: () => ({ k: "atr", period: { k: "num", v: 1 } }),
    unsupportedFn: (callee) => new PineConvertError(`unsupported ${callee}`),
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine numeric call lowering", () => {
  it("lowers moving-average calls through the explicit context boundary", () => {
    expect(lowerNumericCall(context(), call("ta.sma", [
      argument({ t: "ident", name: "close" }),
      argument({ t: "num", v: 20 })
    ]))).toEqual({ k: "ma", kind: "sma", period: { k: "num", v: 20 }, source: { k: "price", field: "close" } });
  });

  it("builds deterministic math.avg arithmetic", () => {
    expect(lowerNumericCall(context(), call("math.avg", [
      argument({ t: "num", v: 2 }),
      argument({ t: "num", v: 4 }),
      argument({ t: "num", v: 6 })
    ]))).toEqual({
      k: "arith",
      op: "/",
      a: { k: "arith", op: "+", a: { k: "arith", op: "+", a: { k: "num", v: 2 }, b: { k: "num", v: 4 } }, b: { k: "num", v: 6 } },
      b: { k: "num", v: 3 }
    });
  });

  it("preserves boolean request.security values as numeric series", () => {
    const ctx = context({ securityVal: () => ({ t: "bool", e: { k: "bool", v: true } }) });
    expect(lowerNumericCall(ctx, call("request.security", []))).toEqual({
      k: "cond",
      cond: { k: "bool", v: true },
      a: { k: "num", v: 1 },
      b: { k: "num", v: 0 }
    });
  });

  it("fails closed for non-deterministic and unsupported numeric calls", () => {
    expect(() => lowerNumericCall(context(), call("math.random", []))).toThrow("non-deterministic");
    expect(() => lowerNumericCall(context(), call("vendor.secret", []))).toThrow("unsupported vendor.secret");
  });
});
