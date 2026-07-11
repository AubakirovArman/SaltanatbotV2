/** Current IR schema version stamped on newly compiled strategies. */
export const IR_VERSION = 4;

const NUM_KINDS = new Set([
  "num", "input", "var", "price", "ma", "rsi", "bollinger", "macd", "atr", "stdev", "extreme", "change",
  "stoch", "wpr", "cci", "roc", "minmax", "arith", "unary", "ctx", "agg", "shift", "cond", "nz", "cum", "barssince", "varprev", "histn",
  "time", "security", "barindex", "valuewhen", "extremebars", "linreg", "vwap", "supertrend", "dmi", "mfi", "cmo", "tsi", "alma", "cog", "percentrank", "sar", "kc", "correlation"
]);

export function isNumExpr(expr) {
  return NUM_KINDS.has(expr.k);
}

export * from "./ta.js";
