import type { BoolExpr, NumExpr } from "../ir";
import { PineConvertError } from "./errors";
import { shiftBool } from "./expressionHistory";
import type { PineExpr } from "./parser";
import { isNaIdent } from "./semanticHelpers";

export interface BooleanExpressionLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  isBooleanExpression(expr: PineExpr): boolean;
  num(expr: PineExpr): NumExpr;
  resolveCall(expr: Extract<PineExpr, { t: "call" }>): BoolExpr;
  resolveIdentifier(name: string): BoolExpr;
  resolveString(expr: PineExpr): string | undefined;
  resolveSwitch(expr: Extract<PineExpr, { t: "switch" }>): BoolExpr;
  warnOnce(key: string, message: string): void;
}

export function lowerBooleanExpression(ctx: BooleanExpressionLoweringContext, expr: PineExpr): BoolExpr {
  switch (expr.t) {
    case "tuplelit":
      throw new PineConvertError("A tuple ([a, b]) can't be used as a condition.");
    case "ident":
      return ctx.resolveIdentifier(expr.name);
    case "field":
    case "method":
      return nonZero(ctx.num(expr));
    case "unary":
      if (expr.op === "not") return { k: "not", a: ctx.bool(expr.a) };
      throw new PineConvertError("A negative number isn't a condition.");
    case "binary":
      return lowerBinary(ctx, expr);
    case "switch":
      return ctx.resolveSwitch(expr);
    case "ternary":
      return lowerTernary(ctx, expr);
    case "call":
      return ctx.resolveCall(expr);
    case "num":
      return nonZero({ k: "num", v: expr.v });
    case "index":
      return lowerHistory(ctx, expr);
    case "str":
      throw new PineConvertError("Expected a condition (true/false expression).");
  }
}

function lowerBinary(ctx: BooleanExpressionLoweringContext, expr: Extract<PineExpr, { t: "binary" }>): BoolExpr {
  if (expr.op === "and" || expr.op === "or") {
    return { k: "logic", op: expr.op, a: ctx.bool(expr.a), b: ctx.bool(expr.b) };
  }
  if (expr.op === "==" || expr.op === "!=") {
    const naSide = isNaIdent(expr.a) ? expr.b : isNaIdent(expr.b) ? expr.a : undefined;
    if (naSide) {
      const test: BoolExpr = { k: "isna", a: ctx.num(naSide) };
      return expr.op === "==" ? test : { k: "not", a: test };
    }
    if (ctx.isBooleanExpression(expr.a) || ctx.isBooleanExpression(expr.b)) {
      const equality = booleanEquality(ctx.bool(expr.a), ctx.bool(expr.b));
      return expr.op === "==" ? equality : { k: "not", a: equality };
    }
    const a = ctx.resolveString(expr.a);
    const b = ctx.resolveString(expr.b);
    if (a !== undefined || b !== undefined) {
      if (a === undefined || b === undefined) {
        ctx.warnOnce("objtextcmp", "Text comparisons against opaque object fields are approximated during import.");
        return { k: "bool", v: expr.op === "!=" };
      }
      return { k: "bool", v: expr.op === "==" ? a === b : a !== b };
    }
  }
  if (["==", "!=", "<", "<=", ">", ">="].includes(expr.op)) {
    return { k: "compare", op: expr.op as ">", a: ctx.num(expr.a), b: ctx.num(expr.b) };
  }
  throw new PineConvertError(`Operator "${expr.op}" doesn't produce a condition.`);
}

function booleanEquality(a: BoolExpr, b: BoolExpr): BoolExpr {
  return {
    k: "logic",
    op: "or",
    a: { k: "logic", op: "and", a, b },
    b: { k: "logic", op: "and", a: { k: "not", a }, b: { k: "not", a: b } }
  };
}

function lowerTernary(ctx: BooleanExpressionLoweringContext, expr: Extract<PineExpr, { t: "ternary" }>): BoolExpr {
  const condition = ctx.bool(expr.cond);
  return {
    k: "logic",
    op: "or",
    a: { k: "logic", op: "and", a: condition, b: ctx.bool(expr.a) },
    b: { k: "logic", op: "and", a: { k: "not", a: condition }, b: ctx.bool(expr.b) }
  };
}

function lowerHistory(ctx: BooleanExpressionLoweringContext, expr: Extract<PineExpr, { t: "index" }>): BoolExpr {
  if (expr.offset.t !== "num" || !Number.isInteger(expr.offset.v) || expr.offset.v < 0) {
    throw new PineConvertError("A condition's history offset [n] must be a non-negative integer literal.");
  }
  return shiftBool(ctx.bool(expr.base), expr.offset.v);
}

function nonZero(value: NumExpr): BoolExpr {
  return { k: "compare", op: "!=", a: value, b: { k: "num", v: 0 } };
}
