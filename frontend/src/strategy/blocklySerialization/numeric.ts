import type { NumExpr } from "../ir";
import type { BlocklySerializationContext } from "./context";
import { block, field, value } from "./xml";

export function serializeNumeric(expr: NumExpr, ctx: BlocklySerializationContext): string {
  const num = (valueExpr: NumExpr) => ctx.num(valueExpr);
  switch (expr.k) {
    case "num": return block("math_number", field("NUM", expr.v));
    case "input": {
      const input = ctx.inputs.get(expr.name);
      const inputValue = input?.value ?? 0;
      return block(
        "param_number",
        field("NAME", expr.name)
          + field("VALUE", inputValue)
          + field("MIN", input?.min ?? inputValue)
          + field("MAX", input?.max ?? inputValue)
          + field("STEP", input?.step ?? 1)
          + field("OPTIMIZE", input?.optimizationEligible === false ? "FALSE" : "TRUE")
      );
    }
    case "var": return block("var_get", field("NAME", expr.name));
    case "price": return expr.offset ? block("market_price_offset", field("FIELD", expr.field) + field("BARS", expr.offset)) : block("market_price", field("FIELD", expr.field));
    case "ma": return block("indicator_ma", field("KIND", expr.kind) + value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "rsi": return block("indicator_rsi", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "bollinger": return block("indicator_bollinger", field("BAND", expr.band) + value("PERIOD", num(expr.period)) + value("DEV", num(expr.dev)) + value("SOURCE", num(expr.source)));
    case "macd": return block("indicator_macd", field("LINE", expr.line) + value("FAST", num(expr.fast)) + value("SLOW", num(expr.slow)) + value("SIGNAL", num(expr.signal)) + value("SOURCE", num(expr.source)));
    case "atr": return block("indicator_atr", value("PERIOD", num(expr.period)));
    case "stdev": return block("indicator_stdev", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "extreme": return block("indicator_extreme", field("KIND", expr.kind) + value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "change": return block("indicator_change", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "stoch": {
      const smooth = expr.smooth.k === "num" ? Math.max(1, Math.round(expr.smooth.v)) : 3;
      return block("indicator_stoch", field("LINE", expr.line) + value("PERIOD", num(expr.period)) + field("SMOOTH", smooth));
    }
    case "wpr": return block("indicator_wpr", value("PERIOD", num(expr.period)));
    case "cci": return block("indicator_cci", value("PERIOD", num(expr.period)));
    case "roc": return block("indicator_roc", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "minmax": return block("math_minmax", field("OP", expr.op) + value("A", num(expr.a)) + value("B", num(expr.b)));
    case "agg": return block("series_agg", field("FN", expr.fn) + value("SOURCE", num(expr.src)) + value("PERIOD", num(expr.period)));
    case "shift": return block("series_shift", value("SOURCE", num(expr.src)) + field("OFFSET", expr.offset));
    case "ctx": return block("ctx_read", field("FIELD", expr.key));
    case "cond": return block("math_cond", value("COND", ctx.bool(expr.cond)) + value("A", num(expr.a)) + value("B", num(expr.b)));
    case "nz": return block("math_nz", value("A", num(expr.a)) + value("B", num(expr.b)));
    case "cum": return block("series_cum", value("SOURCE", num(expr.src)));
    case "barssince": return block("series_barssince", value("COND", ctx.bool(expr.cond)));
    case "varprev": return block("var_prev", field("NAME", expr.name));
    case "histn": return block("market_hist_dyn", field("FIELD", expr.field) + value("OFFSET", num(expr.offset)));
    case "time": return block("market_time", field("SESSION", expr.session ?? "") + field("TIMEZONE", expr.timezone ?? ""));
    case "security": return block("market_security", field("SYMBOL", expr.symbol) + field("TIMEFRAME", expr.timeframe) + value("SOURCE", num(expr.source)));
    case "barindex": return block("market_barindex", "");
    case "valuewhen": return block("indicator_valuewhen", field("OCCURRENCE", expr.occurrence) + value("SRC", num(expr.src)) + value("COND", ctx.bool(expr.cond)));
    case "extremebars": return block("indicator_extremebars", field("KIND", expr.kind) + value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "linreg": return block("indicator_linreg", field("OFFSET", expr.offset) + value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "vwap": return block("indicator_vwap", "");
    case "supertrend": return block("indicator_supertrend", field("LINE", expr.line) + value("FACTOR", num(expr.factor)) + value("PERIOD", num(expr.period)));
    case "dmi": return block("indicator_dmi", field("LINE", expr.line) + value("PERIOD", num(expr.period)) + value("SMOOTHING", num(expr.smoothing)));
    case "mfi": return block("indicator_mfi", value("PERIOD", num(expr.period)));
    case "cmo": return block("indicator_cmo", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "tsi": return block("indicator_tsi", value("SHORT", num(expr.short)) + value("LONG", num(expr.long)) + value("SOURCE", num(expr.source)));
    case "alma": return block("indicator_alma", field("OFFSET", expr.offset) + field("SIGMA", expr.sigma) + value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "cog": return block("indicator_cog", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "percentrank": return block("indicator_percentrank", value("PERIOD", num(expr.period)) + value("SOURCE", num(expr.source)));
    case "sar": return block("indicator_sar", value("START", num(expr.start)) + value("INC", num(expr.inc)) + value("MAX", num(expr.max)));
    case "kc": return block("indicator_kc", field("BAND", expr.band) + value("PERIOD", num(expr.period)) + value("MULT", num(expr.mult)));
    case "correlation": return block("indicator_correlation", value("A", num(expr.a)) + value("B", num(expr.b)) + value("PERIOD", num(expr.period)));
    case "arith": {
      if (expr.op === "%") return block("math_modulo", value("A", num(expr.a)) + value("B", num(expr.b)));
      const operations: Record<string, string> = { "+": "ADD", "-": "MINUS", "*": "MULTIPLY", "/": "DIVIDE", "^": "POWER" };
      return block("math_arithmetic", field("OP", operations[expr.op]) + value("A", num(expr.a)) + value("B", num(expr.b)));
    }
    case "unary": {
      if (new Set(["abs", "neg", "sign", "sqrt", "log", "log10", "exp"]).has(expr.op)) {
        return block("math_single_op", field("OP", expr.op) + value("NUM", num(expr.a)));
      }
      const operations: Record<string, string> = { round: "ROUND", ceil: "ROUNDUP", floor: "ROUNDDOWN" };
      return block("math_round", field("OP", operations[expr.op]) + value("NUM", num(expr.a)));
    }
  }
}
