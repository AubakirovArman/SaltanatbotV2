/** Pine identifiers and compatibility tables owned by the compiler package. */

export const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PLOT_CALLS = new Set(["plot", "hline", "plotshape", "plotchar"]);
export const PINE_NAMESPACES = new Set([
  "array", "barstate", "box", "chart", "color", "display", "extend", "hline", "input", "label", "line", "linefill",
  "location", "map", "math", "matrix", "plot", "polyline", "position", "request", "shape", "size", "str", "strategy",
  "syminfo", "table", "ta", "timeframe", "xloc", "yloc"
]);

/** Drawing-object constructors (label.new, line.new, box.new, …). */
export const DRAWING_NEW_RE = /^(label|line|linefill|box|table|polyline)\.new$/;
/** Drawing-object mutators/removers whose effects we can't track. */
export const DRAWING_MUTATE_RE = /^(label|line|linefill|box|table|polyline)\.(set_\w+|delete|copy|all)$/;

export const COLOR_HEX: Record<string, string> = {
  red: "#ef5350",
  green: "#26a69a",
  lime: "#23c97a",
  blue: "#4db6ff",
  aqua: "#26c6da",
  teal: "#26a69a",
  orange: "#ff9800",
  yellow: "#f7c948",
  purple: "#bd58a4",
  fuchsia: "#e040fb",
  maroon: "#c05f5f",
  navy: "#3949ab",
  olive: "#9e9d24",
  silver: "#b0bec5",
  gray: "#8f9bb3",
  white: "#eceff1",
  black: "#263238"
};

export const MATH_CONSTS: Record<string, number> = {
  "math.pi": Math.PI,
  "math.e": Math.E,
  "math.phi": 1.618033988749895,
  "math.rphi": 0.6180339887498949
};

/** v4 bare names (sma, crossover, study…) -> v5 namespaced equivalents. */
export function normalizeTa(callee: string): string {
  if (callee.includes(".")) return callee;
  const v4ta = new Set([
    "sma", "ema", "wma", "vwma", "rsi", "atr", "tr", "stdev", "highest", "lowest", "change", "mom", "cci", "roc",
    "wpr", "stoch", "vwap", "crossover", "crossunder", "cross", "rising", "falling", "macd", "bb", "correlation"
  ]);
  if (v4ta.has(callee)) return `ta.${callee}`;
  const v4math = new Set(["abs", "round", "floor", "ceil", "max", "min", "pow", "sqrt", "avg"]);
  if (v4math.has(callee)) return `math.${callee}`;
  return callee;
}

export function timeframeToSeconds(value: string): number {
  const text = value.trim();
  if (!text) return 60;
  const match = /^(\d+)?([SMHDW])?$/i.exec(text);
  if (!match) return 60;
  const n = Number(match[1] || 1);
  const unit = (match[2] || "").toUpperCase();
  if (unit === "S") return n;
  if (unit === "H") return n * 3600;
  if (unit === "D") return n * 86_400;
  if (unit === "W") return n * 604_800;
  if (unit === "M") return n * 2_592_000;
  return n * 60;
}
