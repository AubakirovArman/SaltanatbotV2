import type { Candle } from "../../types.js";
import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir.js";
import {
  atr as atrSeries,
  bollingerBand,
  cci,
  change as changeSeries,
  ema,
  highest,
  lowest,
  macdLine,
  roc,
  rsi,
  sma,
  sourceSeries,
  stdev,
  stochK,
  vwma,
  williamsR,
  wma
} from "./ta.js";

export interface BarIntents {
  entry?: "long" | "short";
  exit: boolean;
  stop?: { mode: "price" | "percent" | "atr"; value: number };
  target?: { mode: "price" | "percent" | "atr"; value: number };
  trail?: { mode: "percent" | "atr"; value: number };
  size?: { mode: "units" | "equity_pct" | "risk_pct"; value: number };
  alerts: { message: string }[];
  markers: { dir: "up" | "down"; label: string }[];
}

interface Runtime {
  candles: Candle[];
  n: number;
  params: Map<string, number>;
  vars: Map<string, number>;
  seriesCache: Map<string, number[]>;
}

/**
 * Evaluate the strategy IR at bar `index` over `candles`, returning the raw
 * intents produced on that bar. This is the exact same evaluation the backtest
 * engine uses, so live signals match backtested ones bar-for-bar.
 */
export function evaluateBar(ir: StrategyIR, candles: Candle[], index: number): BarIntents {
  const rt: Runtime = {
    candles,
    n: candles.length,
    params: new Map(ir.inputs.map((input) => [input.name, input.value])),
    vars: new Map(),
    seriesCache: new Map()
  };
  const intents: BarIntents = { exit: false, alerts: [], markers: [] };
  execStatements(ir.body, index, rt, intents);
  return intents;
}

/** Current ATR(period) value at a bar — used by the engine for atr-based stops. */
export function atrValue(candles: Candle[], period: number, index: number): number {
  const series = atrSeries(candles, period);
  return series[index];
}

function execStatements(stmts: Stmt[], i: number, rt: Runtime, intents: BarIntents) {
  for (const stmt of stmts) execStatement(stmt, i, rt, intents);
}

function execStatement(stmt: Stmt, i: number, rt: Runtime, intents: BarIntents) {
  switch (stmt.k) {
    case "entry":
      if (!intents.entry && evalBool(stmt.when, i, rt)) intents.entry = stmt.direction;
      break;
    case "exit":
      if (evalBool(stmt.when, i, rt)) intents.exit = true;
      break;
    case "stop":
      intents.stop = { mode: stmt.mode, value: evalNum(stmt.value, i, rt) };
      break;
    case "target":
      intents.target = { mode: stmt.mode, value: evalNum(stmt.value, i, rt) };
      break;
    case "trail":
      intents.trail = { mode: stmt.mode, value: evalNum(stmt.value, i, rt) };
      break;
    case "size":
      intents.size = { mode: stmt.mode, value: evalNum(stmt.value, i, rt) };
      break;
    case "setvar":
      rt.vars.set(stmt.name, evalNum(stmt.value, i, rt));
      break;
    case "alert":
      if (evalBool(stmt.when, i, rt)) intents.alerts.push({ message: stmt.message });
      break;
    case "marker":
      if (evalBool(stmt.when, i, rt)) intents.markers.push({ dir: stmt.dir, label: stmt.label });
      break;
    case "plot":
      break;
    case "if":
      if (evalBool(stmt.cond, i, rt)) execStatements(stmt.then, i, rt, intents);
      break;
  }
}

function evalNum(expr: NumExpr, i: number, rt: Runtime): number {
  switch (expr.k) {
    case "var":
      return rt.vars.get(expr.name) ?? 0;
    case "arith": {
      const a = evalNum(expr.a, i, rt);
      const b = evalNum(expr.b, i, rt);
      return applyArith(expr.op, a, b);
    }
    case "unary":
      return applyUnary(expr.op, evalNum(expr.a, i, rt));
    default:
      return getSeries(expr, rt)[i];
  }
}

function evalBool(expr: BoolExpr, i: number, rt: Runtime): boolean {
  switch (expr.k) {
    case "bool":
      return expr.v;
    case "compare": {
      const a = evalNum(expr.a, i, rt);
      const b = evalNum(expr.b, i, rt);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      switch (expr.op) {
        case ">": return a > b;
        case "<": return a < b;
        case ">=": return a >= b;
        case "<=": return a <= b;
        case "==": return a === b;
        case "!=": return a !== b;
      }
      return false;
    }
    case "logic":
      return expr.op === "and"
        ? evalBool(expr.a, i, rt) && evalBool(expr.b, i, rt)
        : evalBool(expr.a, i, rt) || evalBool(expr.b, i, rt);
    case "not":
      return !evalBool(expr.a, i, rt);
    case "cross": {
      if (i < 1) return false;
      const a = getSeries(expr.a, rt);
      const b = getSeries(expr.b, rt);
      if ([a[i], a[i - 1], b[i], b[i - 1]].some(Number.isNaN)) return false;
      const above = a[i - 1] <= b[i - 1] && a[i] > b[i];
      const below = a[i - 1] >= b[i - 1] && a[i] < b[i];
      if (expr.dir === "above") return above;
      if (expr.dir === "below") return below;
      return above || below;
    }
    case "trend": {
      const period = Math.max(1, Math.round(constNum(expr.period, rt)));
      if (i < period) return false;
      const s = getSeries(expr.source, rt);
      if (Number.isNaN(s[i]) || Number.isNaN(s[i - period])) return false;
      return expr.dir === "rising" ? s[i] > s[i - period] : s[i] < s[i - period];
    }
    case "between": {
      const v = evalNum(expr.value, i, rt);
      const low = evalNum(expr.low, i, rt);
      const high = evalNum(expr.high, i, rt);
      return v >= Math.min(low, high) && v <= Math.max(low, high);
    }
    case "session": {
      const hour = new Date(rt.candles[i].time).getUTCHours();
      return expr.start <= expr.end
        ? hour >= expr.start && hour <= expr.end
        : hour >= expr.start || hour <= expr.end;
    }
    case "dayofweek":
      return new Date(rt.candles[i].time).getUTCDay() === expr.day;
  }
}

function getSeries(expr: NumExpr, rt: Runtime): number[] {
  const key = JSON.stringify(expr);
  const cached = rt.seriesCache.get(key);
  if (cached) return cached;
  const series = computeSeries(expr, rt);
  rt.seriesCache.set(key, series);
  return series;
}

function computeSeries(expr: NumExpr, rt: Runtime): number[] {
  const n = rt.n;
  switch (expr.k) {
    case "num":
      return new Array<number>(n).fill(expr.v);
    case "input":
      return new Array<number>(n).fill(rt.params.get(expr.name) ?? 0);
    case "var":
      return new Array<number>(n).fill(NaN);
    case "price": {
      const base = sourceSeries(rt.candles, expr.field);
      if (!expr.offset) return base;
      const shifted = new Array<number>(n).fill(NaN);
      for (let i = expr.offset; i < n; i += 1) shifted[i] = base[i - expr.offset];
      return shifted;
    }
    case "ma": {
      const src = getSeries(expr.source, rt);
      const period = Math.max(1, Math.round(constNum(expr.period, rt)));
      if (expr.kind === "ema") return ema(src, period);
      if (expr.kind === "wma") return wma(src, period);
      if (expr.kind === "vwma") return vwma(src, sourceSeries(rt.candles, "volume"), period);
      return sma(src, period);
    }
    case "rsi":
      return rsi(getSeries(expr.source, rt), Math.max(1, Math.round(constNum(expr.period, rt))));
    case "bollinger":
      return bollingerBand(getSeries(expr.source, rt), Math.max(1, Math.round(constNum(expr.period, rt))), constNum(expr.dev, rt) || 2, expr.band);
    case "macd":
      return macdLine(
        getSeries(expr.source, rt),
        Math.max(1, Math.round(constNum(expr.fast, rt))),
        Math.max(1, Math.round(constNum(expr.slow, rt))),
        Math.max(1, Math.round(constNum(expr.signal, rt))),
        expr.line
      );
    case "atr":
      return atrSeries(rt.candles, Math.max(1, Math.round(constNum(expr.period, rt))));
    case "stdev":
      return stdev(getSeries(expr.source, rt), Math.max(1, Math.round(constNum(expr.period, rt))));
    case "extreme": {
      const src = getSeries(expr.source, rt);
      const period = Math.max(1, Math.round(constNum(expr.period, rt)));
      return expr.kind === "highest" ? highest(src, period) : lowest(src, period);
    }
    case "change":
      return changeSeries(getSeries(expr.source, rt), Math.max(1, Math.round(constNum(expr.period, rt))));
    case "stoch": {
      const period = Math.max(1, Math.round(constNum(expr.period, rt)));
      const smooth = Math.max(1, Math.round(constNum(expr.smooth, rt)));
      const k = stochK(rt.candles, period);
      return expr.line === "k" ? k : sma(k.map((v) => (Number.isNaN(v) ? 0 : v)), smooth).map((v, i) => (Number.isNaN(k[i]) ? NaN : v));
    }
    case "wpr":
      return williamsR(rt.candles, Math.max(1, Math.round(constNum(expr.period, rt))));
    case "cci":
      return cci(rt.candles, Math.max(1, Math.round(constNum(expr.period, rt))));
    case "roc":
      return roc(getSeries(expr.source, rt), Math.max(1, Math.round(constNum(expr.period, rt))));
    case "minmax": {
      const a = getSeries(expr.a, rt);
      const b = getSeries(expr.b, rt);
      return a.map((value, i) => (expr.op === "min" ? Math.min(value, b[i]) : Math.max(value, b[i])));
    }
    case "arith": {
      const a = getSeries(expr.a, rt);
      const b = getSeries(expr.b, rt);
      return a.map((value, i) => applyArith(expr.op, value, b[i]));
    }
    case "unary": {
      const a = getSeries(expr.a, rt);
      return a.map((value) => applyUnary(expr.op, value));
    }
  }
}

function applyArith(op: "+" | "-" | "*" | "/" | "%", a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? NaN : a / b;
    case "%": return b === 0 ? NaN : a % b;
  }
}

function applyUnary(op: "neg" | "abs" | "round" | "floor" | "ceil", a: number): number {
  switch (op) {
    case "neg": return -a;
    case "abs": return Math.abs(a);
    case "round": return Math.round(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
  }
}

function constNum(expr: NumExpr, rt: Runtime): number {
  switch (expr.k) {
    case "num": return expr.v;
    case "input": return rt.params.get(expr.name) ?? NaN;
    case "arith": return applyArith(expr.op, constNum(expr.a, rt), constNum(expr.b, rt));
    case "unary": return applyUnary(expr.op, constNum(expr.a, rt));
    default: return NaN;
  }
}
