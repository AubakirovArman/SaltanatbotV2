import type { BoolExpr, NumExpr } from "../ir";
import { arg, argRequired } from "./arguments";
import { PineConvertError } from "./errors";
import { timeframeToSeconds, normalizeTa } from "./language";
import type { PineArg, PineExpr } from "./parser";
import { boolToNumericSeries, isCollectionCallName, isObjectConstructor, type PineValue } from "./semanticHelpers";

export interface NumericCallLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  collectionCallNum(callee: string, args: PineArg[]): NumExpr;
  constPositiveInt(expr: NumExpr, fallback: number): number;
  contextString(expr: PineExpr): string | undefined;
  hma(source: NumExpr, length: NumExpr): NumExpr;
  kcNode(args: PineArg[], band: "upper" | "middle" | "lower"): NumExpr;
  literalArg(args: PineArg[], position: number, name: string, fn: string, fallback: number): number;
  num(expr: PineExpr): NumExpr;
  numArg(args: PineArg[], position: number, name: string, fallback?: NumExpr): NumExpr;
  opaqueNum(key: string, message: string): NumExpr;
  securityVal(args: PineArg[]): PineValue;
  seriesArg(args: PineArg[], position: number, name: string): NumExpr;
  strVal(expr: PineExpr): string | undefined;
  swma(source: NumExpr): NumExpr;
  timeCall(args: PineArg[]): NumExpr;
  trueRange(): NumExpr;
  unsupportedFn(callee: string): PineConvertError;
  warnOnce(key: string, message: string): void;
}

/** Pine `na` represented as numeric NaN in the vectorized IR. */
const NAN_NUM: NumExpr = { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } };

export function lowerNumericCall(
  ctx: NumericCallLoweringContext,
  expr: Extract<PineExpr, { t: "call" }>
): NumExpr {
    const callee = normalizeTa(expr.callee);
    const args = expr.args;
    const period = (i: number, name: string) => ctx.numArg(args, i, name);

    if (isCollectionCallName(expr.callee)) return ctx.collectionCallNum(expr.callee, args);
    if (isObjectConstructor(expr.callee)) return ctx.opaqueNum("objects", "User-defined Pine object constructors are imported as opaque visual values.");
    if (expr.callee === "request.financial") {
      ctx.warnOnce("financial", "request.financial() is imported as unavailable fundamental data (na) until a fundamentals provider is wired.");
      return NAN_NUM;
    }
    if (callee === "int" || callee === "float") return ctx.numArg(args, 0, "value", { k: "num", v: 0 });

    if (callee === "request.security" || callee === "security") {
      const value = ctx.securityVal(args);
      if (value.t === "str") throw new PineConvertError("request.security() can't return text.");
      return value.t === "bool" ? boolToNumericSeries(value.e) : value.e;
    }

    if (callee === "time" || callee === "time_close") return ctx.timeCall(args);

    if (callee === "timeframe.in_seconds") {
      const tfArg = arg(args, 0, "timeframe");
      const tf = tfArg ? ctx.contextString(tfArg.value) ?? ctx.strVal(tfArg.value) : "chart";
      if (tf === undefined) throw new PineConvertError("timeframe.in_seconds() needs a static timeframe string.");
      if (tf === "chart" || tf === "") {
        ctx.warnOnce("tfseconds", "timeframe.in_seconds(chart) approximated as 60 seconds because the imported script is not bound to a chart timeframe yet.");
        return { k: "num", v: 60 };
      }
      return { k: "num", v: timeframeToSeconds(tf) };
    }

    if (callee === "slope" || callee.endsWith(".slope")) {
      ctx.warnOnce("slope", `${expr.callee}() imported as (source - source[length bars ago]) / length.`);
      const src = ctx.seriesArg(args, 0, "source");
      const len = ctx.numArg(args, 1, "length", { k: "num", v: 1 });
      return { k: "arith", op: "/", a: { k: "arith", op: "-", a: src, b: { k: "shift", src, offset: ctx.constPositiveInt(len, 1) } }, b: len };
    }

    switch (callee) {
      case "ta.sma":
      case "ta.ema":
      case "ta.rma":
      case "ta.wma":
      case "ta.vwma": {
        const kind = callee.slice(3) as "sma" | "ema" | "rma" | "wma" | "vwma";
        return { k: "ma", kind, period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      }
      case "ta.hma":
        return ctx.hma(ctx.seriesArg(args, 0, "source"), period(1, "length"));
      case "ta.swma":
        return ctx.swma(ctx.seriesArg(args, 0, "source"));
      case "ta.rsi":
        return { k: "rsi", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.atr":
        return { k: "atr", period: period(0, "length") };
      case "ta.tr":
        // Exact True Range: max(high-low, |high-close[1]|, |low-close[1]|).
        return ctx.trueRange();
      case "ta.stdev":
      case "ta.dev": {
        const src = ctx.seriesArg(args, 0, "source");
        const len = period(1, "length");
        if (callee === "ta.dev") {
          // Mean absolute deviation: sma(|src - sma(src,len)|, len).
          const mean: NumExpr = { k: "ma", kind: "sma", period: len, source: src };
          return { k: "agg", fn: "avg", src: { k: "unary", op: "abs", a: { k: "arith", op: "-", a: src, b: mean } }, period: len };
        }
        return { k: "stdev", period: len, source: src };
      }
      case "ta.variance": {
        ctx.warnOnce("variance", "ta.variance computed as stdev²(len).");
        const sd: NumExpr = { k: "stdev", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
        return { k: "arith", op: "^", a: sd, b: { k: "num", v: 2 } };
      }
      case "ta.correlation":
        return {
          k: "correlation",
          a: ctx.seriesArg(args, 0, "source1"),
          b: ctx.seriesArg(args, 1, "source2"),
          period: period(2, "length")
        };
      case "ta.sum":
        return { k: "agg", fn: "sum", src: ctx.seriesArg(args, 0, "source"), period: period(1, "length") };
      case "ta.median":
        return { k: "agg", fn: "median", src: ctx.seriesArg(args, 0, "source"), period: period(1, "length") };
      case "ta.cum":
        return { k: "cum", src: ctx.seriesArg(args, 0, "source") };
      case "ta.barssince":
        return { k: "barssince", cond: ctx.bool(argRequired(args, 0, "condition", "ta.barssince").value) };
      case "ta.bbw": {
        // Bollinger Band Width: (upper - lower) / middle.
        const src = ctx.seriesArg(args, 0, "source");
        const len = period(1, "length");
        const mult = ctx.numArg(args, 2, "mult", { k: "num", v: 2 });
        const upper: NumExpr = { k: "bollinger", band: "upper", period: len, dev: mult, source: src };
        const lower: NumExpr = { k: "bollinger", band: "lower", period: len, dev: mult, source: src };
        const middle: NumExpr = { k: "bollinger", band: "middle", period: len, dev: mult, source: src };
        return { k: "arith", op: "/", a: { k: "arith", op: "-", a: upper, b: lower }, b: middle };
      }
      case "ta.highest":
      case "ta.lowest": {
        const kind = callee === "ta.highest" ? "highest" : "lowest";
        if (args.length === 1) {
          return { k: "extreme", kind, period: period(0, "length"), source: { k: "price", field: kind === "highest" ? "high" : "low" } };
        }
        return { k: "extreme", kind, period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      }
      case "ta.change":
        return { k: "change", period: args.filter((a) => !a.name).length > 1 ? period(1, "length") : { k: "num", v: 1 }, source: ctx.seriesArg(args, 0, "source") };
      case "ta.mom":
        return { k: "change", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.cci": {
        const src = args[0]?.value;
        if (!(src && src.t === "ident" && src.name === "hlc3")) ctx.warnOnce("cci", "ta.cci computed from hlc3 here (the passed source is ignored).");
        return { k: "cci", period: period(1, "length") };
      }
      case "ta.roc":
        return { k: "roc", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.wpr":
        return { k: "wpr", period: period(0, "length") };
      case "ta.stoch":
        ctx.warnOnce("stoch", "ta.stoch imported as raw %K of close/high/low.");
        return { k: "stoch", line: "k", period: ctx.numArg(args, 3, "length", { k: "num", v: 14 }), smooth: { k: "num", v: 1 } };
      case "ta.vwap": {
        if (args.length) ctx.warnOnce("vwapsrc", "ta.vwap is computed from hlc3·volume here (the passed source/anchor arguments are ignored).");
        return { k: "vwap" };
      }
      case "ta.valuewhen": {
        const cond = ctx.bool(argRequired(args, 0, "condition", "ta.valuewhen").value);
        const src = ctx.seriesArg(args, 1, "source");
        const occurrence = ctx.literalArg(args, 2, "occurrence", "ta.valuewhen", 0);
        if (!Number.isInteger(occurrence) || occurrence < 0) {
          throw new PineConvertError("ta.valuewhen() occurrence must be a non-negative integer literal (0 = most recent).");
        }
        return { k: "valuewhen", cond, src, occurrence };
      }
      case "ta.highestbars":
      case "ta.lowestbars": {
        const kind = callee === "ta.highestbars" ? "highest" : "lowest";
        if (args.length === 1) {
          return { k: "extremebars", kind, period: period(0, "length"), source: { k: "price", field: kind === "highest" ? "high" : "low" } };
        }
        return { k: "extremebars", kind, period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      }
      case "ta.linreg": {
        const offset = ctx.literalArg(args, 2, "offset", "ta.linreg", 0);
        if (!Number.isInteger(offset)) throw new PineConvertError("ta.linreg() offset must be an integer literal.");
        return { k: "linreg", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source"), offset };
      }
      case "ta.supertrend":
        // Used undestructured → the SuperTrend line value.
        ctx.warnOnce("stline", "ta.supertrend() used in an expression → the SuperTrend line value (destructure [line, dir] for the direction).");
        return { k: "supertrend", line: "value", factor: ctx.numArg(args, 0, "factor"), period: ctx.numArg(args, 1, "atrPeriod") };
      case "ta.dmi":
        // Used undestructured → the ADX line.
        ctx.warnOnce("dmiline", "ta.dmi() used in an expression → the ADX line (destructure [plus, minus, adx] for the DI lines).");
        return { k: "dmi", line: "adx", period: ctx.numArg(args, 0, "diLength"), smoothing: ctx.numArg(args, 1, "adxSmoothing") };
      case "ta.mfi": {
        // v5 signature is (source, length); the 1-arg form (length) is also accepted.
        if (args.filter((a) => !a.name).length === 1 && !arg(args, undefined, "source")) {
          return { k: "mfi", period: period(0, "length") };
        }
        const src = args[0]?.value;
        if (!(src && src.t === "ident" && src.name === "hlc3")) ctx.warnOnce("mfi", "ta.mfi computed from hlc3 here (the passed source is ignored).");
        return { k: "mfi", period: period(1, "length") };
      }
      case "ta.cmo":
        return { k: "cmo", period: period(1, "length"), source: ctx.seriesArg(args, 0, "series") };
      case "ta.tsi":
        return { k: "tsi", short: period(1, "short_length"), long: period(2, "long_length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.alma": {
        const offset = ctx.literalArg(args, 2, "offset", "ta.alma", 0.85);
        const sigma = ctx.literalArg(args, 3, "sigma", "ta.alma", 6);
        return { k: "alma", period: period(1, "length"), source: ctx.seriesArg(args, 0, "series"), offset, sigma };
      }
      case "ta.cog":
        return { k: "cog", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.percentrank":
        return { k: "percentrank", period: period(1, "length"), source: ctx.seriesArg(args, 0, "source") };
      case "ta.sar":
        return { k: "sar", start: ctx.numArg(args, 0, "start"), inc: ctx.numArg(args, 1, "inc"), max: ctx.numArg(args, 2, "max") };
      case "ta.kc":
        // Used undestructured → the middle line.
        ctx.warnOnce("kcline", "ta.kc() used in an expression → the middle line (destructure [middle, upper, lower] for the bands).");
        return ctx.kcNode(args, "middle");
      case "math.abs":
        return { k: "unary", op: "abs", a: ctx.numArg(args, 0, "number") };
      case "math.round": {
        if (args.filter((a) => !a.name).length > 1) ctx.warnOnce("roundprec", "math.round precision argument ignored (rounds to whole numbers).");
        return { k: "unary", op: "round", a: ctx.numArg(args, 0, "number") };
      }
      case "math.floor":
        return { k: "unary", op: "floor", a: ctx.numArg(args, 0, "number") };
      case "math.ceil":
        return { k: "unary", op: "ceil", a: ctx.numArg(args, 0, "number") };
      case "math.max":
      case "math.min": {
        const op = callee === "math.max" ? "max" : "min";
        if (args.length < 2) throw new PineConvertError(`${callee} needs at least two arguments.`);
        let acc: NumExpr = ctx.num(args[0].value);
        for (let i = 1; i < args.length; i += 1) acc = { k: "minmax", op, a: acc, b: ctx.num(args[i].value) };
        return acc;
      }
      case "math.pow":
        return { k: "arith", op: "^", a: ctx.numArg(args, 0, "base"), b: ctx.numArg(args, 1, "exponent") };
      case "math.sqrt":
        return { k: "unary", op: "sqrt", a: ctx.numArg(args, 0, "number") };
      case "math.sign":
        return { k: "unary", op: "sign", a: ctx.numArg(args, 0, "number") };
      case "math.log":
        return { k: "unary", op: "log", a: ctx.numArg(args, 0, "number") };
      case "math.log10":
        return { k: "unary", op: "log10", a: ctx.numArg(args, 0, "number") };
      case "math.exp":
        return { k: "unary", op: "exp", a: ctx.numArg(args, 0, "number") };
      case "math.todegrees":
        return { k: "arith", op: "*", a: ctx.numArg(args, 0, "radians"), b: { k: "num", v: 180 / Math.PI } };
      case "math.toradians":
        return { k: "arith", op: "*", a: ctx.numArg(args, 0, "degrees"), b: { k: "num", v: Math.PI / 180 } };
      case "math.round_to_mintick":
        ctx.warnOnce("mintick", "math.round_to_mintick passed through unrounded (tick size isn't known here).");
        return ctx.numArg(args, 0, "number");
      case "math.avg": {
        if (args.length < 2) throw new PineConvertError("math.avg needs at least two arguments.");
        let sum: NumExpr = ctx.num(args[0].value);
        for (let i = 1; i < args.length; i += 1) sum = { k: "arith", op: "+", a: sum, b: ctx.num(args[i].value) };
        return { k: "arith", op: "/", a: sum, b: { k: "num", v: args.length } };
      }
      case "math.sin":
      case "math.cos":
      case "math.tan":
      case "math.asin":
      case "math.acos":
      case "math.atan":
        throw new PineConvertError(`${callee}() (trigonometry) isn't supported — no trig primitive in the strategy engine.`);
      case "math.random":
        throw new PineConvertError("math.random() is non-deterministic and can't run identically in backtest and live.");
      case "nz":
        return { k: "nz", a: ctx.numArg(args, 0, "source"), b: ctx.numArg(args, 1, "replacement", { k: "num", v: 0 }) };
      case "fixnan":
        ctx.warnOnce("fixnan", "fixnan() passed through (warm-up NaNs aren't forward-filled here).");
        return ctx.numArg(args, 0, "source");
      case "iff": {
        // Pine's legacy iff(cond, a, b) — a numeric ternary.
        const cond = ctx.bool(argRequired(args, 0, "condition", "iff").value);
        return { k: "cond", cond, a: ctx.numArg(args, 1, "then"), b: ctx.numArg(args, 2, "else") };
      }
      case "ta.macd": {
        // Used undestructured (e.g. `ta.macd(...) > 0`) → the MACD line.
        ctx.warnOnce("macdline", "ta.macd() used in an expression → the MACD line (destructure [m, s, h] for signal/histogram).");
        const src = ctx.seriesArg(args, 0, "source");
        return { k: "macd", line: "macd", fast: period(1, "fastlen"), slow: period(2, "slowlen"), signal: period(3, "siglen"), source: src };
      }
      case "color.new":
      case "color.rgb":
        throw new PineConvertError("color values can't be used as numbers.");
      default:
        throw ctx.unsupportedFn(expr.callee);
    }
}
