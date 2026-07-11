import type { BoolExpr, NumExpr } from "../ir";
import { PineConvertError } from "./errors";
import { MATH_CONSTS, PRICE_FIELDS } from "./language";
import { isUserObjectFieldName, type PineValue } from "./semanticHelpers";

export interface IdentifierLoweringContext {
  addBooleanVariable(name: string): void;
  addNumericVariable(name: string): void;
  boundValue(name: string): PineValue | undefined;
  hasBooleanInput(name: string): boolean;
  hasBooleanVariable(name: string): boolean;
  hasDrawingHandle(name: string): boolean;
  hasNumericVariable(name: string): boolean;
  hasOpaqueState(name: string): boolean;
  hasPlotHandle(name: string): boolean;
  storageName(name: string): string;
  trueRange(): NumExpr;
  unsupportedFunction(name: string): PineConvertError;
  warnOnce(key: string, message: string): void;
}

const NAN_NUM: NumExpr = { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } };

export function lowerNumericIdentifier(ctx: IdentifierLoweringContext, name: string): NumExpr {
  const target = ctx.storageName(name);
  const bound = ctx.boundValue(name);
  if (bound) {
    if (bound.t === "str") throw new PineConvertError(`"${name}" is a text value ("${bound.v}"), not a number.`);
    if (bound.t !== "num") throw new PineConvertError(`"${name}" is a condition, not a number.`);
    return bound.e;
  }
  if (ctx.hasOpaqueState(name) || ctx.hasOpaqueState(target)) return opaqueRead(ctx);
  if (PRICE_FIELDS.has(name)) return { k: "price", field: name as never };
  if (ctx.hasNumericVariable(name)) return { k: "var", name };
  if (target !== name && ctx.hasNumericVariable(target)) return { k: "var", name: target };
  const constant = MATH_CONSTS[name];
  if (constant !== undefined) return { k: "num", v: constant };
  if (name === "ta.tr") return ctx.trueRange();
  if (name === "ta.vwap") return { k: "vwap" };
  if (name.startsWith("ta.")) throw ctx.unsupportedFunction(name);
  if (name === "strategy.position_size") {
    ctx.warnOnce("possize", "strategy.position_size is mapped to the position DIRECTION sign (+1/-1/0), not the size.");
    return { k: "ctx", key: "position_dir" };
  }
  if (name === "strategy.equity") return { k: "ctx", key: "equity" };
  if (name === "strategy.position_avg_price") return { k: "ctx", key: "entry_price" };
  if (name === "strategy.openprofit") return { k: "ctx", key: "unrealized_pnl" };
  if (["strategy.wintrades", "strategy.losstrades", "strategy.closedtrades", "strategy.netprofit"].includes(name)) {
    throw new PineConvertError(`${name} (whole-backtest strategy stats) isn't available to a live per-bar engine.`);
  }
  if (name === "bar_index" || name === "n") {
    ctx.warnOnce("barindex", "bar_index is relative to the loaded history window — absolute values differ between backtest and live; differences (bar_index - x) are safe.");
    return { k: "barindex" };
  }
  if (name === "last_bar_index") throw new PineConvertError("last_bar_index (the index of the final bar) needs knowledge of the future — it isn't available in a live per-bar engine.");
  if (name.startsWith("barstate.")) return numericBarState(ctx, name);
  if (name === "time" || name === "time_close" || name === "time_tradingday") return { k: "time" };
  if (["year", "month", "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second"].includes(name)) {
    ctx.warnOnce("timeparts", "Calendar built-ins (year/month/day/hour) are approximated until exchange timezone calendars are modeled.");
    return { k: "num", v: name === "month" || name === "dayofmonth" || name === "dayofweek" ? 1 : name === "year" ? 1970 : 0 };
  }
  if (name === "timenow") throw new PineConvertError("timenow reads wall-clock time and is non-deterministic — it can't run identically in backtest and live.");
  if (name === "timeframe.multiplier") return approximateMetadata(ctx, 60);
  if (name.startsWith("timeframe.is")) return approximateMetadata(ctx, 0);
  if (name.startsWith("syminfo.")) {
    ctx.warnOnce("symmeta", "symbol metadata is approximated during import; text metadata is frozen/skipped.");
    return { k: "num", v: 0 };
  }
  if (isDrawingNamespace(name)) return drawingRead(ctx, name);
  if (ctx.hasPlotHandle(name) || ctx.hasPlotHandle(target)) throw new PineConvertError(`"${name}" is a plot handle — it can't be used as a value.`);
  if (ctx.hasDrawingHandle(name) || ctx.hasDrawingHandle(target)) {
    ctx.warnOnce("handleread", `Drawing handles ("${name}") have no value here — reads yield na.`);
    return NAN_NUM;
  }
  if (name.includes(".")) {
    const head = name.split(".")[0];
    if (ctx.boundValue(head) || ctx.hasNumericVariable(head) || ctx.hasBooleanVariable(head)) {
      ctx.warnOnce("objfield", "User-defined object fields are imported as opaque values; dependent visuals may be approximated.");
      return NAN_NUM;
    }
  }
  if (name === "na") return NAN_NUM;
  if (target !== name && isUserObjectFieldName(name)) {
    ctx.warnOnce("objstate", "User-defined object fields are flattened into scalar state variables; collection/object fidelity is approximate.");
    ctx.addNumericVariable(target);
    return { k: "var", name: target };
  }
  throw new PineConvertError(`Unknown identifier "${name}" — it was never assigned (or its definition was skipped).`);
}

export function lowerBooleanIdentifier(ctx: IdentifierLoweringContext, name: string): BoolExpr {
  const target = ctx.storageName(name);
  if (name === "true" || name === "false") return { k: "bool", v: name === "true" };
  if (name.startsWith("barstate.")) {
    ctx.warnOnce("barstate", "barstate.* is approximated for import: last-bar visual branches are skipped, confirmed-bar logic remains deterministic.");
    return { k: "bool", v: name === "barstate.isconfirmed" || name === "barstate.ishistory" };
  }
  if (name.startsWith("timeframe.is")) {
    ctx.warnOnce("tfmeta", "timeframe metadata is approximated during import until chart-bound timeframe context is available.");
    return { k: "bool", v: false };
  }
  if (ctx.hasBooleanInput(name)) return nonZero({ k: "input", name });
  const bound = ctx.boundValue(name);
  if (bound) {
    if (bound.t === "str") throw new PineConvertError(`"${name}" is a text value ("${bound.v}"), not a condition.`);
    return bound.t === "num" ? nonZero(bound.e) : bound.e;
  }
  if (ctx.hasBooleanVariable(name)) return { k: "varb", name };
  if (target !== name && ctx.hasBooleanVariable(target)) return { k: "varb", name: target };
  if (ctx.hasNumericVariable(name)) return nonZero({ k: "var", name });
  if (target !== name && ctx.hasNumericVariable(target)) return nonZero({ k: "var", name: target });
  if (ctx.hasOpaqueState(name) || ctx.hasOpaqueState(target)) {
    opaqueRead(ctx);
    return { k: "bool", v: false };
  }
  if (target !== name && isUserObjectFieldName(name)) {
    ctx.warnOnce("objstate", "User-defined object fields are flattened into scalar state variables; collection/object fidelity is approximate.");
    ctx.addBooleanVariable(target);
    return { k: "varb", name: target };
  }
  throw new PineConvertError(`Unknown condition "${name}".`);
}

function nonZero(value: NumExpr): BoolExpr {
  return { k: "compare", op: "!=", a: value, b: { k: "num", v: 0 } };
}

function opaqueRead(ctx: IdentifierLoweringContext): NumExpr {
  ctx.warnOnce("opaqueread", "Reads from imported collection/object state return na unless mapped to a scalar plot.");
  return NAN_NUM;
}

function numericBarState(ctx: IdentifierLoweringContext, name: string): NumExpr {
  ctx.warnOnce("barstate", "barstate.* is approximated for import: last-bar visual branches are skipped, confirmed-bar logic remains deterministic.");
  return { k: "num", v: name === "barstate.isconfirmed" || name === "barstate.ishistory" ? 1 : 0 };
}

function approximateMetadata(ctx: IdentifierLoweringContext, value: number): NumExpr {
  ctx.warnOnce("tfmeta", "timeframe metadata is approximated during import until chart-bound timeframe context is available.");
  return { k: "num", v: value };
}

function isDrawingNamespace(name: string): boolean {
  return ["label.", "line.", "linefill.", "box.", "table.", "polyline.", "chart."].some((prefix) => name.startsWith(prefix));
}

function drawingRead(ctx: IdentifierLoweringContext, name: string): NumExpr {
  if (name === "chart.left_visible_bar_time" || name === "chart.right_visible_bar_time") {
    ctx.warnOnce("chartmeta", "chart visible-range metadata is approximated with the current bar time during import.");
    return { k: "time" };
  }
  ctx.warnOnce("drawread", "Drawing/table/chart object values are imported as opaque visual state; reads return na.");
  return NAN_NUM;
}
