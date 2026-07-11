export type PriceField = "open" | "high" | "low" | "close" | "volume" | "hl2" | "hlc3" | "ohlc4";

export type MaKind = "sma" | "ema" | "wma" | "vwma" | "rma";

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
  | { k: "unary"; op: "neg" | "abs" | "round" | "floor" | "ceil" | "sign" | "log" | "log10" | "exp" | "sqrt"; a: NumExpr }
  | { k: "agg"; fn: "sum" | "avg" | "min" | "max" | "stdev" | "median"; src: NumExpr; period: NumExpr }
  | { k: "shift"; src: NumExpr; offset: number }
  | { k: "ctx"; key: CtxKey }
  | { k: "cond"; cond: BoolExpr; a: NumExpr; b: NumExpr }
  | { k: "nz"; a: NumExpr; b: NumExpr }
  | { k: "cum"; src: NumExpr }
  | { k: "barssince"; cond: BoolExpr }
  | { k: "varprev"; name: string }
  | { k: "histn"; field: PriceField; offset: NumExpr }
  | { k: "time"; session?: string; timezone?: string }
  | { k: "security"; symbol: string; timeframe: string; source: NumExpr }
  | { k: "barindex" }
  | { k: "valuewhen"; cond: BoolExpr; src: NumExpr; occurrence: number }
  | { k: "extremebars"; kind: "highest" | "lowest"; period: NumExpr; source: NumExpr }
  | { k: "linreg"; period: NumExpr; source: NumExpr; offset: number }
  | { k: "vwap" }
  | { k: "supertrend"; line: "value" | "dir"; factor: NumExpr; period: NumExpr }
  | { k: "dmi"; line: "plus" | "minus" | "adx"; period: NumExpr; smoothing: NumExpr }
  | { k: "mfi"; period: NumExpr }
  | { k: "cmo"; period: NumExpr; source: NumExpr }
  | { k: "tsi"; short: NumExpr; long: NumExpr; source: NumExpr }
  | { k: "alma"; period: NumExpr; source: NumExpr; offset: number; sigma: number }
  | { k: "cog"; period: NumExpr; source: NumExpr }
  | { k: "percentrank"; period: NumExpr; source: NumExpr }
  | { k: "sar"; start: NumExpr; inc: NumExpr; max: NumExpr }
  | { k: "kc"; band: "upper" | "middle" | "lower"; period: NumExpr; mult: NumExpr }
  | { k: "correlation"; a: NumExpr; b: NumExpr; period: NumExpr };

export type CtxKey =
  | "position_dir"
  | "entry_price"
  | "unrealized_pnl"
  | "unrealized_pnl_pct"
  | "bars_in_position"
  | "last_trade_pnl"
  | "consecutive_losses"
  | "trades_today"
  | "realized_today"
  | "equity";

export type BoolExpr =
  | { k: "bool"; v: boolean }
  | { k: "compare"; op: ">" | "<" | ">=" | "<=" | "==" | "!="; a: NumExpr; b: NumExpr }
  | { k: "logic"; op: "and" | "or"; a: BoolExpr; b: BoolExpr }
  | { k: "not"; a: BoolExpr }
  | { k: "cross"; dir: "above" | "below" | "any"; a: NumExpr; b: NumExpr }
  | { k: "trend"; dir: "rising" | "falling"; period: NumExpr; source: NumExpr }
  | { k: "between"; value: NumExpr; low: NumExpr; high: NumExpr }
  | { k: "session"; start: number; end: number }
  | { k: "dayofweek"; day: number }
  | { k: "varb"; name: string }
  | { k: "isna"; a: NumExpr };

export type Stmt =
  | { k: "entry"; direction: "long" | "short"; when: BoolExpr }
  | { k: "exit"; when: BoolExpr }
  | { k: "stop"; mode: "price" | "percent" | "atr"; value: NumExpr }
  | { k: "target"; mode: "price" | "percent" | "atr"; value: NumExpr }
  | { k: "trail"; mode: "percent" | "atr"; value: NumExpr }
  | { k: "size"; mode: "units" | "equity_pct" | "risk_pct"; value: NumExpr }
  | { k: "setvar"; name: string; value: NumExpr }
  | { k: "setvarb"; name: string; value: BoolExpr }
  | { k: "alert"; message: string; when: BoolExpr; args?: Record<string, NumExpr> }
  | { k: "plot"; value: NumExpr; label: string; color: string; pane?: "price" | "sub" }
  | { k: "marker"; dir: "up" | "down"; label: string; when: BoolExpr }
  | { k: "box"; top: NumExpr; bottom: NumExpr; when: BoolExpr; label: string; color: string }
  | { k: "projection"; left: NumExpr; right: NumExpr; top: NumExpr; bottom: NumExpr; when: BoolExpr; label: string; color: string }
  | { k: "metric"; table: string; column: string; label: string; value: NumExpr; when: BoolExpr }
  | { k: "vline"; when: BoolExpr; label: string; color: string }
  | { k: "ray"; price: NumExpr; when: BoolExpr; label: string; color: string }
  | { k: "if"; cond: BoolExpr; then: Stmt[]; elifs?: { cond: BoolExpr; then: Stmt[] }[]; else?: Stmt[] }
  | { k: "repeat"; count: NumExpr; body: Stmt[] }
  | { k: "while"; cond: BoolExpr; body: Stmt[]; cap: number }
  | { k: "for"; var: string; from: NumExpr; to: NumExpr; step: NumExpr; body: Stmt[]; cap: number };

export interface StrategyInput {
  name: string;
  value: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  optimizationEligible?: boolean;
}

export interface StrategyIR {
  name: string;
  inputs: StrategyInput[];
  body: Stmt[];
  init?: Stmt[];
  v?: number;
}

export const IR_VERSION: 4;

export function isNumExpr(expr: NumExpr | BoolExpr): expr is NumExpr;

export * from "./ta.js";
export * from "./securityData.js";
export * from "./evaluator.js";
export * from "./trace.js";
