import type { NumExpr, Stmt } from "../ir";
import { PineConvertError } from "./errors";
import { normalizeTa } from "./language";
import type { PineArg, PineExpr } from "./parser";
import type { PineValue } from "./semanticHelpers";

export interface TupleLoweringContext {
  bind(name: string, value: PineValue): void;
  checkName(name: string): void;
  hasUserFunction(name: string): boolean;
  inlineUserFunctionTuple(name: string, args: PineArg[]): PineValue[];
  keltner(args: PineArg[], band: "upper" | "middle" | "lower"): NumExpr;
  numArg(args: PineArg[], position: number, name: string, fallback?: NumExpr): NumExpr;
  value(expr: PineExpr): PineValue;
}

export function lowerTupleAssignment(ctx: TupleLoweringContext, names: string[], value: PineExpr): Stmt[] {
  if (value.t === "tuplelit") {
    bindValues(ctx, names, value.items.map((item) => ctx.value(item)));
    return [];
  }
  if (value.t !== "call") throw new PineConvertError("Tuple assignment must destructure a function call.");
  if (ctx.hasUserFunction(value.callee)) {
    bindValues(ctx, names, ctx.inlineUserFunctionTuple(value.callee, value.args));
    return [];
  }
  bindValues(ctx, names, lowerBuiltInTuple(ctx, value));
  return [];
}

function lowerBuiltInTuple(ctx: TupleLoweringContext, call: Extract<PineExpr, { t: "call" }>): PineValue[] {
  const callee = normalizeTa(call.callee);
  let parts: NumExpr[];
  if (callee === "ta.macd") {
    const source = ctx.numArg(call.args, 0, "source", { k: "price", field: "close" });
    const fast = ctx.numArg(call.args, 1, "fastlen");
    const slow = ctx.numArg(call.args, 2, "slowlen");
    const signal = ctx.numArg(call.args, 3, "siglen");
    parts = (["macd", "signal", "histogram"] as const).map((line) => ({ k: "macd", line, fast, slow, signal, source }));
  } else if (callee === "ta.bb") {
    const source = ctx.numArg(call.args, 0, "series");
    const period = ctx.numArg(call.args, 1, "length");
    const dev = ctx.numArg(call.args, 2, "mult");
    parts = (["middle", "upper", "lower"] as const).map((band) => ({ k: "bollinger", band, period, dev, source }));
  } else if (callee === "ta.supertrend") {
    const factor = ctx.numArg(call.args, 0, "factor");
    const period = ctx.numArg(call.args, 1, "atrPeriod");
    parts = (["value", "dir"] as const).map((line) => ({ k: "supertrend", line, factor, period }));
  } else if (callee === "ta.dmi") {
    const period = ctx.numArg(call.args, 0, "diLength");
    const smoothing = ctx.numArg(call.args, 1, "adxSmoothing");
    parts = (["plus", "minus", "adx"] as const).map((line) => ({ k: "dmi", line, period, smoothing }));
  } else if (callee === "ta.kc") {
    parts = [ctx.keltner(call.args, "middle"), ctx.keltner(call.args, "upper"), ctx.keltner(call.args, "lower")];
  } else {
    throw new PineConvertError(`Tuple destructuring is only supported for ta.macd, ta.bb, ta.supertrend, ta.dmi and ta.kc (got ${call.callee}).`);
  }
  return parts.map((expression) => ({ t: "num", e: expression }));
}

function bindValues(ctx: TupleLoweringContext, names: string[], values: PineValue[]): void {
  names.forEach((name, index) => {
    ctx.checkName(name);
    const value = values[index];
    if (value) ctx.bind(name, value);
  });
}
