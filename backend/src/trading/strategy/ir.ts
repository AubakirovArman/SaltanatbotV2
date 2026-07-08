import type { PriceField } from "./ta.js";

export type MaKind = "sma" | "ema" | "wma" | "vwma";

/** Numeric expression — evaluates to a number on every bar. */
export type NumExpr =
  | { k: "num"; v: number }
  | { k: "input"; name: string }
  | { k: "var"; name: string }
  | { k: "price"; field: PriceField; offset?: number }
  | { k: "ma"; kind: MaKind; period: NumExpr; source: NumExpr }
  | { k: "rsi"; period: NumExpr; source: NumExpr }
  | { k: "bollinger"; band: "upper" | "middle" | "lower"; period: NumExpr; dev: NumExpr; source: NumExpr }
  | { k: "macd"; line: "macd" | "signal" | "histogram"; fast: NumExpr; slow: NumExpr; signal: NumExpr; source: NumExpr }
  | { k: "atr"; period: NumExpr }
  | { k: "stdev"; period: NumExpr; source: NumExpr }
  | { k: "extreme"; kind: "highest" | "lowest"; period: NumExpr; source: NumExpr }
  | { k: "change"; period: NumExpr; source: NumExpr }
  | { k: "stoch"; line: "k" | "d"; period: NumExpr; smooth: NumExpr }
  | { k: "wpr"; period: NumExpr }
  | { k: "cci"; period: NumExpr }
  | { k: "roc"; period: NumExpr; source: NumExpr }
  | { k: "minmax"; op: "min" | "max"; a: NumExpr; b: NumExpr }
  | { k: "arith"; op: "+" | "-" | "*" | "/" | "%"; a: NumExpr; b: NumExpr }
  | { k: "unary"; op: "neg" | "abs" | "round" | "floor" | "ceil"; a: NumExpr };

/** Boolean expression — evaluates to true/false on every bar. */
export type BoolExpr =
  | { k: "bool"; v: boolean }
  | { k: "compare"; op: ">" | "<" | ">=" | "<=" | "==" | "!="; a: NumExpr; b: NumExpr }
  | { k: "logic"; op: "and" | "or"; a: BoolExpr; b: BoolExpr }
  | { k: "not"; a: BoolExpr }
  | { k: "cross"; dir: "above" | "below" | "any"; a: NumExpr; b: NumExpr }
  | { k: "trend"; dir: "rising" | "falling"; period: NumExpr; source: NumExpr }
  | { k: "between"; value: NumExpr; low: NumExpr; high: NumExpr }
  | { k: "session"; start: number; end: number }
  | { k: "dayofweek"; day: number };

export type Stmt =
  | { k: "entry"; direction: "long" | "short"; when: BoolExpr }
  | { k: "exit"; when: BoolExpr }
  | { k: "stop"; mode: "price" | "percent" | "atr"; value: NumExpr }
  | { k: "target"; mode: "price" | "percent" | "atr"; value: NumExpr }
  | { k: "trail"; mode: "percent" | "atr"; value: NumExpr }
  | { k: "size"; mode: "units" | "equity_pct" | "risk_pct"; value: NumExpr }
  | { k: "setvar"; name: string; value: NumExpr }
  | { k: "alert"; message: string; when: BoolExpr }
  | { k: "plot"; value: NumExpr; label: string; color: string }
  | { k: "marker"; dir: "up" | "down"; label: string; when: BoolExpr }
  | { k: "if"; cond: BoolExpr; then: Stmt[] };

export interface StrategyInput {
  name: string;
  value: number;
}

export interface StrategyIR {
  name: string;
  inputs: StrategyInput[];
  body: Stmt[];
}

const NUM_KINDS = new Set([
  "num", "input", "var", "price", "ma", "rsi", "bollinger", "macd", "atr", "stdev", "extreme", "change",
  "stoch", "wpr", "cci", "roc", "minmax", "arith", "unary"
]);

export function isNumExpr(expr: NumExpr | BoolExpr): expr is NumExpr {
  return NUM_KINDS.has(expr.k);
}
