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
  | { k: "arith"; op: "+" | "-" | "*" | "/" | "%" | "^"; a: NumExpr; b: NumExpr }
  | { k: "unary"; op: "neg" | "abs" | "round" | "floor" | "ceil"; a: NumExpr }
  | { k: "agg"; fn: "sum" | "avg" | "min" | "max" | "stdev" | "median"; src: NumExpr; period: NumExpr }
  | { k: "shift"; src: NumExpr; offset: number }
  | { k: "ctx"; key: CtxKey };

/** Runtime-context reads: the current position/PnL state, supplied per bar by the
 *  backtester and the live engine. Scalar-only (never a series). */
export type CtxKey = "position_dir" | "entry_price" | "unrealized_pnl" | "unrealized_pnl_pct" | "bars_in_position";

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
  | { k: "alert"; message: string; when: BoolExpr; args?: Record<string, NumExpr> }
  | { k: "plot"; value: NumExpr; label: string; color: string }
  | { k: "marker"; dir: "up" | "down"; label: string; when: BoolExpr }
  | { k: "if"; cond: BoolExpr; then: Stmt[]; elifs?: { cond: BoolExpr; then: Stmt[] }[]; else?: Stmt[] }
  | { k: "repeat"; count: NumExpr; body: Stmt[] }
  | { k: "while"; cond: BoolExpr; body: Stmt[]; cap: number };

export interface StrategyInput {
  name: string;
  value: number;
}

export interface StrategyIR {
  name: string;
  inputs: StrategyInput[];
  body: Stmt[];
  /** Statements run ONCE at strategy/bot start (before the first bar). Restricted
   *  to `setvar` — this is the "on start" section for initializing state. */
  init?: Stmt[];
  /** IR schema version. Absent = legacy v1. Bumped when node shapes change so an
   *  old backend rejects (rather than misexecutes) a newer strategy. */
  v?: number;
}

/** Current IR schema version stamped on newly compiled strategies. */
export const IR_VERSION = 1;

const NUM_KINDS = new Set([
  "num", "input", "var", "price", "ma", "rsi", "bollinger", "macd", "atr", "stdev", "extreme", "change",
  "stoch", "wpr", "cci", "roc", "minmax", "arith", "unary", "ctx", "agg", "shift"
]);

export function isNumExpr(expr: NumExpr | BoolExpr): expr is NumExpr {
  return NUM_KINDS.has(expr.k);
}
