import type { NumExpr } from "../ir";
import { PineConvertError } from "./errors";
import { containsVar } from "./expressionHistory";
import type { PineExpr } from "./parser";

export interface NumericExpressionLoweringContext {
  bool(expr: PineExpr): import("../ir").BoolExpr;
  hasBoundValue(name: string): boolean;
  isIntegerLike(expr: PineExpr): boolean;
  isMutableNumber(name: string): boolean;
  num(expr: PineExpr): NumExpr;
  resolveCall(expr: Extract<PineExpr, { t: "call" }>): NumExpr;
  resolveField(expr: Extract<PineExpr, { t: "field" }>): NumExpr;
  resolveIdentifier(name: string): NumExpr;
  resolveMethod(expr: Extract<PineExpr, { t: "method" }>): NumExpr;
  resolveSwitch(expr: Extract<PineExpr, { t: "switch" }>): NumExpr;
  warnOnce(key: string, message: string): void;
}

export function lowerNumericExpression(ctx: NumericExpressionLoweringContext, expr: PineExpr): NumExpr {
  switch (expr.t) {
    case "tuplelit":
      throw new PineConvertError("A tuple ([a, b]) can't be used as a single number.");
    case "num":
      return { k: "num", v: expr.v };
    case "str":
      throw new PineConvertError("A text value can't be used as a number.");
    case "ident":
      return ctx.resolveIdentifier(expr.name);
    case "field":
      return ctx.resolveField(expr);
    case "method":
      return ctx.resolveMethod(expr);
    case "unary":
      if (expr.op === "-") return { k: "unary", op: "neg", a: ctx.num(expr.a) };
      throw new PineConvertError("'not' can't be used as a number.");
    case "binary":
      return lowerBinary(ctx, expr);
    case "ternary":
      return { k: "cond", cond: ctx.bool(expr.cond), a: ctx.num(expr.a), b: ctx.num(expr.b) };
    case "switch":
      return ctx.resolveSwitch(expr);
    case "index":
      return lowerHistory(ctx, expr);
    case "call":
      return ctx.resolveCall(expr);
  }
}

function lowerBinary(ctx: NumericExpressionLoweringContext, expr: Extract<PineExpr, { t: "binary" }>): NumExpr {
  if (!["+", "-", "*", "/", "%"].includes(expr.op)) {
    throw new PineConvertError(`Operator "${expr.op}" doesn't produce a number.`);
  }
  if (expr.op === "/" && ctx.isIntegerLike(expr.a) && ctx.isIntegerLike(expr.b)) {
    ctx.warnOnce("intdiv", "Pine integer division truncates (7/2=3); here it stays fractional — wrap with math.floor if the script relies on truncation.");
  }
  return { k: "arith", op: expr.op as "+", a: ctx.num(expr.a), b: ctx.num(expr.b) };
}

function lowerHistory(ctx: NumericExpressionLoweringContext, expr: Extract<PineExpr, { t: "index" }>): NumExpr {
  const offsetExpr = expr.offset;
  const literal = offsetExpr.t === "num" && Number.isInteger(offsetExpr.v) && offsetExpr.v >= 0 ? offsetExpr.v : undefined;

  if (expr.base.t === "ident" && ctx.isMutableNumber(expr.base.name) && !ctx.hasBoundValue(expr.base.name)) {
    if (literal === 0) return { k: "var", name: expr.base.name };
    if (literal === 1) return { k: "varprev", name: expr.base.name };
    throw new PineConvertError(`Only the previous bar (${expr.base.name}[1]) is available for a mutable variable, not a further/dynamic offset.`);
  }

  const base = ctx.num(expr.base);
  if (base.k === "barindex") return { k: "arith", op: "-", a: base, b: ctx.num(offsetExpr) };
  if (literal !== undefined) {
    if (containsVar(base)) {
      throw new PineConvertError("History access on a mutable variable (x[1]) isn't supported — variables hold only their latest value.");
    }
    if (literal === 0) return base;
    if (base.k === "price" && !base.offset) return { k: "price", field: base.field, offset: literal };
    return { k: "shift", src: base, offset: literal };
  }
  if (base.k === "price" && !base.offset) return { k: "histn", field: base.field, offset: ctx.num(offsetExpr) };
  throw new PineConvertError(
    "A dynamic history offset (x[i]) is only supported on a raw price field (close[i], high[i], …), not on an indicator or computed series."
  );
}
