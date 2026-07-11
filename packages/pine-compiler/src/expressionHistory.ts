import type { BoolExpr, NumExpr } from "@saltanatbotv2/strategy-core";
import { PineConvertError } from "./errors";

/** Shift a numeric series expression back by n bars. */
export function shiftNum(expr: NumExpr, n: number): NumExpr {
  if (n === 0) return expr;
  if (expr.k === "num" || expr.k === "input") return expr;
  if (expr.k === "var") {
    if (n === 1) return { k: "varprev", name: expr.name };
    throw new PineConvertError(`Only the previous bar ([1]) is available for variable "${expr.name}", not [${n}].`);
  }
  if (expr.k === "arith") return { k: "arith", op: expr.op, a: shiftNum(expr.a, n), b: shiftNum(expr.b, n) };
  if (expr.k === "minmax") return { k: "minmax", op: expr.op, a: shiftNum(expr.a, n), b: shiftNum(expr.b, n) };
  if (expr.k === "unary") return { k: "unary", op: expr.op, a: shiftNum(expr.a, n) };
  if (containsVar(expr)) throw new PineConvertError("History of a mutable-variable expression isn't supported.");
  if (expr.k === "price") return { k: "price", field: expr.field, offset: (expr.offset ?? 0) + n };
  if (expr.k === "shift") return { k: "shift", src: expr.src, offset: expr.offset + n };
  return { k: "shift", src: expr, offset: n };
}

/** Shift an inlined boolean expression back by n bars. */
export function shiftBool(expr: BoolExpr, n: number): BoolExpr {
  if (n === 0) return expr;
  switch (expr.k) {
    case "bool":
      return expr;
    case "varb":
      if (n === 1) return { k: "compare", op: "!=", a: { k: "varprev", name: expr.name }, b: { k: "num", v: 0 } };
      throw new PineConvertError(`Only the previous bar (${expr.name}[1]) is available for a flag variable, not [${n}].`);
    case "compare":
      return { k: "compare", op: expr.op, a: shiftNum(expr.a, n), b: shiftNum(expr.b, n) };
    case "logic":
      return { k: "logic", op: expr.op, a: shiftBool(expr.a, n), b: shiftBool(expr.b, n) };
    case "not":
      return { k: "not", a: shiftBool(expr.a, n) };
    case "between":
      return { k: "between", value: shiftNum(expr.value, n), low: shiftNum(expr.low, n), high: shiftNum(expr.high, n) };
    case "isna":
      return { k: "isna", a: shiftNum(expr.a, n) };
    default:
      throw new PineConvertError(`The history of this condition (${expr.k}) can't be computed — rewrite it without [n] on that sub-expression.`);
  }
}

/** Constant-expression check used for initialization and exit-freeze warnings. */
export function isConstNum(expr: NumExpr): boolean {
  if (expr.k === "num" || expr.k === "input") return true;
  if (expr.k === "unary") return isConstNum(expr.a);
  if (expr.k === "arith") return isConstNum(expr.a) && isConstNum(expr.b);
  return false;
}

/** Whether a numeric expression transitively reads mutable state. */
export function containsVar(expr: NumExpr): boolean {
  switch (expr.k) {
    case "var":
    case "varprev":
    case "histn":
      return true;
    case "security":
      return containsVar(expr.source);
    case "time":
      return false;
    case "arith":
    case "minmax":
    case "nz":
      return containsVar(expr.a) || containsVar(expr.b);
    case "unary":
      return containsVar(expr.a);
    case "shift":
    case "cum":
      return containsVar(expr.src);
    case "cond":
      return containsVarInBool(expr.cond) || containsVar(expr.a) || containsVar(expr.b);
    case "barssince":
      return containsVarInBool(expr.cond);
    case "agg":
      return containsVar(expr.src) || containsVar(expr.period);
    case "ma":
    case "rsi":
    case "stdev":
    case "extreme":
    case "change":
    case "roc":
    case "extremebars":
    case "linreg":
    case "cmo":
    case "alma":
    case "cog":
    case "percentrank":
      return containsVar(expr.source) || containsVar(expr.period);
    case "bollinger":
      return containsVar(expr.source) || containsVar(expr.period) || containsVar(expr.dev);
    case "macd":
      return containsVar(expr.source) || containsVar(expr.fast) || containsVar(expr.slow) || containsVar(expr.signal);
    case "valuewhen":
      return containsVarInBool(expr.cond) || containsVar(expr.src);
    case "supertrend":
      return containsVar(expr.factor) || containsVar(expr.period);
    case "dmi":
      return containsVar(expr.period) || containsVar(expr.smoothing);
    case "mfi":
      return containsVar(expr.period);
    case "kc":
      return containsVar(expr.period) || containsVar(expr.mult);
    case "tsi":
      return containsVar(expr.source) || containsVar(expr.short) || containsVar(expr.long);
    case "sar":
      return containsVar(expr.start) || containsVar(expr.inc) || containsVar(expr.max);
    case "correlation":
      return containsVar(expr.a) || containsVar(expr.b) || containsVar(expr.period);
    default:
      return false;
  }
}

function containsVarInBool(expr: BoolExpr): boolean {
  switch (expr.k) {
    case "varb":
      return true;
    case "compare":
    case "cross":
      return containsVar(expr.a) || containsVar(expr.b);
    case "logic":
      return containsVarInBool(expr.a) || containsVarInBool(expr.b);
    case "not":
      return containsVarInBool(expr.a);
    case "trend":
      return containsVar(expr.source) || containsVar(expr.period);
    case "between":
      return containsVar(expr.value) || containsVar(expr.low) || containsVar(expr.high);
    case "isna":
      return containsVar(expr.a);
    default:
      return false;
  }
}
