import type { BoolExpr, NumExpr } from "../ir";
import { argRequired } from "./arguments";
import { PineConvertError } from "./errors";
import { normalizeTa } from "./language";
import type { PineArg, PineExpr } from "./parser";
import { isCollectionCallName, isObjectMethodCallName, type PineValue } from "./semanticHelpers";

export interface BooleanCallLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  hasUserFunction(name: string): boolean;
  inlineUserFunction(name: string, args: PineArg[]): PineValue;
  num(expr: PineExpr): NumExpr;
  numArg(args: PineArg[], position: number, name: string): NumExpr;
  numCall(expr: Extract<PineExpr, { t: "call" }>): NumExpr;
  securityVal(args: PineArg[]): PineValue;
  seriesArg(args: PineArg[], position: number, name: string): NumExpr;
  timeCall(args: PineArg[]): NumExpr;
  warnOnce(key: string, message: string): void;
}

export function lowerBooleanCall(
  ctx: BooleanCallLoweringContext,
  expr: Extract<PineExpr, { t: "call" }>
): BoolExpr {
  if (ctx.hasUserFunction(expr.callee)) {
    const value = ctx.inlineUserFunction(expr.callee, expr.args);
    if (value.t !== "bool") throw new PineConvertError(`"${expr.callee}()" returns a number, not a condition.`);
    return value.e;
  }

  const callee = normalizeTa(expr.callee);
  if (callee === "request.security" || callee === "security") {
    const value = ctx.securityVal(expr.args);
    if (value.t === "str") throw new PineConvertError("request.security() can't return text.");
    return value.t === "bool" ? value.e : nonZero(value.e);
  }
  if (callee === "time" || callee === "time_close") return nonZero(ctx.timeCall(expr.args));
  if (callee === "timeframe.change") {
    ctx.warnOnce("tfchange", "timeframe.change() is approximated as false until multi-timeframe bar-boundary context is available.");
    return { k: "bool", v: false };
  }
  if (isCollectionCallName(expr.callee) || isObjectMethodCallName(expr.callee)) return nonZero(ctx.numCall(expr));
  if (callee === "ta.crossover") return cross(ctx, expr.args, "above");
  if (callee === "ta.crossunder") return cross(ctx, expr.args, "below");
  if (callee === "ta.cross") return cross(ctx, expr.args, "any");
  if (callee === "ta.rising" || callee === "ta.falling") return risingFalling(ctx, callee, expr.args);
  if (callee === "na") return { k: "isna", a: ctx.num(argRequired(expr.args, 0, "x", "na").value) };
  if (callee === "iff") {
    const cond = ctx.bool(argRequired(expr.args, 0, "condition", "iff").value);
    return {
      k: "logic",
      op: "or",
      a: { k: "logic", op: "and", a: cond, b: ctx.bool(argRequired(expr.args, 1, "then", "iff").value) },
      b: { k: "logic", op: "and", a: { k: "not", a: cond }, b: ctx.bool(argRequired(expr.args, 2, "else", "iff").value) }
    };
  }
  return nonZero(ctx.numCall(expr));
}

function nonZero(value: NumExpr): BoolExpr {
  return { k: "compare", op: "!=", a: value, b: { k: "num", v: 0 } };
}

function cross(ctx: BooleanCallLoweringContext, args: PineArg[], dir: "above" | "below" | "any"): BoolExpr {
  return { k: "cross", dir, a: ctx.numArg(args, 0, "a"), b: ctx.numArg(args, 1, "b") };
}

/** Pine rising/falling compares against every value in the previous window. */
function risingFalling(ctx: BooleanCallLoweringContext, callee: string, args: PineArg[]): BoolExpr {
  const source = ctx.seriesArg(args, 0, "source");
  const length = ctx.numArg(args, 1, "length");
  const rising = callee === "ta.rising";
  if (length.k === "num" && length.v === 1) {
    return { k: "trend", dir: rising ? "rising" : "falling", period: { k: "num", v: 1 }, source };
  }
  const window: NumExpr = {
    k: "extreme",
    kind: rising ? "highest" : "lowest",
    period: length,
    source: { k: "shift", src: source, offset: 1 }
  };
  return { k: "compare", op: rising ? ">" : "<", a: source, b: window };
}
