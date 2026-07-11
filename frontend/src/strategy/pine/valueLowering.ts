import type { BoolExpr, NumExpr } from "../ir";
import type { PineArg, PineExpr } from "./parser";
import type { PineValue } from "./semanticHelpers";

export interface ValueLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  hasUserFunction(name: string): boolean;
  inlineUserFunction(name: string, args: PineArg[]): PineValue;
  isBooleanExpression(expr: PineExpr): boolean;
  num(expr: PineExpr): NumExpr;
  string(expr: PineExpr): string | undefined;
  switchValue(expr: Extract<PineExpr, { t: "switch" }>): PineValue;
}

/** Resolve Pine's dynamically shaped AST value into a typed compiler value. */
export function lowerValue(ctx: ValueLoweringContext, expr: PineExpr): PineValue {
  if (expr.t === "call" && ctx.hasUserFunction(expr.callee)) return ctx.inlineUserFunction(expr.callee, expr.args);
  if (expr.t === "switch") return ctx.switchValue(expr);
  const stringValue = ctx.string(expr);
  if (stringValue !== undefined) return { t: "str", v: stringValue };
  if (ctx.isBooleanExpression(expr)) return { t: "bool", e: ctx.bool(expr) };
  return { t: "num", e: ctx.num(expr) };
}
