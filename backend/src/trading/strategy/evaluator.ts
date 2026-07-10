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
  priceAt,
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
  /** Set when the bar hit the per-bar op budget and execution was truncated. */
  budgetExceeded?: boolean;
}

/** Hard per-bar execution budget: bounds total statement/loop work so live stays
 *  deterministic. MUST equal the frontend backtester's constant for parity. */
const MAX_OPS_PER_BAR = 10_000;
/** Max iterations a single `repeat` can request (also clamped by the op budget). */
const MAX_REPEAT = 1000;

interface Runtime {
  candles: Candle[];
  n: number;
  params: Map<string, number>;
  vars: Map<string, number>;
  seriesCache: Map<string, number[]>;
  /** Statements/iterations executed this bar; guarded against MAX_OPS_PER_BAR. */
  ops: number;
  budgetHit: boolean;
  /** Position/PnL runtime context supplied per bar by the caller (ctx reads). */
  ctx: Record<string, number>;
  /** Snapshot of vars at the START of the bar — reads for `varprev` (x[1] on a var). */
  varsPrev: Map<string, number>;
}

/**
 * Evaluate the strategy IR at bar `index` over `candles`, returning the raw
 * intents produced on that bar. This is the exact same evaluation the backtest
 * engine uses, so live signals match backtested ones bar-for-bar.
 *
 * `vars` is the persistent variable store: the frontend backtester keeps one
 * store for the whole run, so `setvar` state (counters, saved levels) survives
 * across bars. Live callers must pass the SAME map every bar for parity —
 * omitting it (fresh map per bar) makes stateful strategies behave differently.
 * The series cache is always per-call (candles grow each bar, so it can't persist).
 */
export function evaluateBar(ir: StrategyIR, candles: Candle[], index: number, vars?: Map<string, number>, ctx?: Record<string, number>): BarIntents {
  const rt: Runtime = {
    candles,
    n: candles.length,
    params: new Map(ir.inputs.map((input) => [input.name, input.value])),
    vars: vars ?? new Map(),
    seriesCache: new Map(),
    varsPrev: new Map(),
    ops: 0,
    budgetHit: false,
    ctx: ctx ?? {}
  };
  const intents: BarIntents = { exit: false, alerts: [], markers: [] };
  rt.varsPrev = new Map(rt.vars);
  execStatements(ir.body, index, rt, intents);
  if (rt.budgetHit) intents.budgetExceeded = true;
  return intents;
}

/**
 * Run the strategy's one-time `init` (on-start) statements, mutating `vars`.
 * Called once when a bot first starts (not on resume, where state is restored).
 * init is setvar-only, evaluated against the first available bar.
 */
export function runInit(ir: StrategyIR, candles: Candle[], vars: Map<string, number>): void {
  if (!ir.init?.length) return;
  const rt: Runtime = {
    candles,
    n: candles.length,
    params: new Map(ir.inputs.map((input) => [input.name, input.value])),
    vars,
    seriesCache: new Map(),
    varsPrev: new Map(),
    ops: 0,
    budgetHit: false,
    ctx: {}
  };
  const intents: BarIntents = { exit: false, alerts: [], markers: [] };
  for (const stmt of ir.init) execStatement(stmt, 0, rt, intents);
}

/** Current ATR(period) value at a bar — used by the engine for atr-based stops. */
export function atrValue(candles: Candle[], period: number, index: number): number {
  const series = atrSeries(candles, period);
  return series[index];
}

function execStatements(stmts: Stmt[], i: number, rt: Runtime, intents: BarIntents) {
  for (const stmt of stmts) {
    if (rt.ops >= MAX_OPS_PER_BAR) {
      rt.budgetHit = true;
      return;
    }
    rt.ops += 1;
    execStatement(stmt, i, rt, intents);
  }
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
    case "setvarb":
      rt.vars.set(stmt.name, evalBool(stmt.value, i, rt) ? 1 : 0);
      break;
    case "alert":
      if (evalBool(stmt.when, i, rt)) intents.alerts.push({ message: renderAlert(stmt.message, stmt.args, i, rt) });
      break;
    case "marker":
      if (evalBool(stmt.when, i, rt)) intents.markers.push({ dir: stmt.dir, label: stmt.label });
      break;
    case "plot":
      break;
    case "if": {
      if (evalBool(stmt.cond, i, rt)) {
        execStatements(stmt.then, i, rt, intents);
        break;
      }
      let matched = false;
      for (const clause of stmt.elifs ?? []) {
        if (evalBool(clause.cond, i, rt)) {
          execStatements(clause.then, i, rt, intents);
          matched = true;
          break;
        }
      }
      if (!matched && stmt.else) execStatements(stmt.else, i, rt, intents);
      break;
    }
    case "repeat": {
      const raw = Math.round(evalNum(stmt.count, i, rt));
      const n = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_REPEAT, raw)) : 0;
      for (let k = 0; k < n; k += 1) {
        if (rt.ops >= MAX_OPS_PER_BAR) {
          rt.budgetHit = true;
          break;
        }
        rt.ops += 1;
        execStatements(stmt.body, i, rt, intents);
      }
      break;
    }
    case "while": {
      let iter = 0;
      while (iter < stmt.cap && evalBool(stmt.cond, i, rt)) {
        if (rt.ops >= MAX_OPS_PER_BAR) {
          rt.budgetHit = true;
          break;
        }
        rt.ops += 1;
        execStatements(stmt.body, i, rt, intents);
        iter += 1;
      }
      break;
    }
    case "for": {
      const fromVal = evalNum(stmt.from, i, rt);
      const toVal = evalNum(stmt.to, i, rt);
      const rawStep = evalNum(stmt.step, i, rt);
      // Pine infers direction from from/to; `by` is a magnitude (auto-subtracted when to<from).
      const mag = Number.isNaN(rawStep) || rawStep === 0 ? 1 : Math.abs(rawStep);
      const asc = toVal >= fromVal;
      const step = asc ? mag : -mag;
      let iter = 0;
      for (let v = fromVal; asc ? v <= toVal : v >= toVal; v += step) {
        if (iter >= stmt.cap || rt.ops >= MAX_OPS_PER_BAR) {
          rt.budgetHit = true;
          break;
        }
        rt.ops += 1;
        rt.vars.set(stmt.var, v);
        execStatements(stmt.body, i, rt, intents);
        iter += 1;
      }
      break;
    }
  }
}

/** Render an alert template: replace {name} placeholders with the numeric value of
 *  args[name] at this bar. Args are numbers only, so no injection reaches Telegram. */
function renderAlert(message: string, args: Record<string, NumExpr> | undefined, i: number, rt: Runtime): string {
  if (!args) return message;
  return message.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const expr = args[key];
    if (!expr) return whole;
    const v = evalNum(expr, i, rt);
    return Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : "n/a";
  });
}

function evalNum(expr: NumExpr, i: number, rt: Runtime): number {
  switch (expr.k) {
    case "var":
      return rt.vars.get(expr.name) ?? 0;
    case "ctx":
      return rt.ctx[expr.key] ?? 0;
    case "varprev":
      return rt.varsPrev.get(expr.name) ?? NaN;
    case "histn": {
      const off = Math.round(evalNum(expr.offset, i, rt));
      const j = i - off;
      if (!Number.isFinite(off) || j < 0 || j >= rt.candles.length) return NaN;
      return priceAt(rt.candles[j], expr.field);
    }
    case "cond":
      return evalBool(expr.cond, i, rt) ? evalNum(expr.a, i, rt) : evalNum(expr.b, i, rt);
    case "nz": {
      const x = evalNum(expr.a, i, rt);
      return Number.isFinite(x) ? x : evalNum(expr.b, i, rt);
    }
    case "minmax": {
      const a = evalNum(expr.a, i, rt);
      const b = evalNum(expr.b, i, rt);
      return expr.op === "min" ? Math.min(a, b) : Math.max(a, b);
    }
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
    case "varb":
      return (rt.vars.get(expr.name) ?? 0) !== 0;
    case "isna":
      return !Number.isFinite(evalNum(expr.a, i, rt));
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
    case "ctx":
      return new Array<number>(n).fill(rt.ctx[expr.key] ?? 0);
    case "varprev":
      return new Array<number>(n).fill(NaN);
    case "histn":
      // Dynamic history offsets can't vectorize — histn is scalar-only (loop bodies).
      return new Array<number>(n).fill(NaN);
    case "cond": {
      const ca = getSeries(expr.a, rt);
      const cb = getSeries(expr.b, rt);
      const out = new Array<number>(n);
      for (let idx = 0; idx < n; idx += 1) out[idx] = evalBool(expr.cond, idx, rt) ? ca[idx] : cb[idx];
      return out;
    }
    case "nz": {
      const na = getSeries(expr.a, rt);
      const nb = getSeries(expr.b, rt);
      return na.map((x, idx) => (Number.isFinite(x) ? x : nb[idx]));
    }
    case "cum": {
      const cs = getSeries(expr.src, rt);
      const out = new Array<number>(n);
      let acc = 0;
      for (let idx = 0; idx < n; idx += 1) {
        if (Number.isFinite(cs[idx])) acc += cs[idx];
        out[idx] = acc;
      }
      return out;
    }
    case "barssince": {
      const out = new Array<number>(n).fill(NaN);
      let last = -1;
      for (let idx = 0; idx < n; idx += 1) {
        if (evalBool(expr.cond, idx, rt)) last = idx;
        if (last >= 0) out[idx] = idx - last;
      }
      return out;
    }
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
      if (expr.kind === "rma") return wilderRma(src, period);
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
    case "agg": {
      const src = getSeries(expr.src, rt);
      const period = Math.min(500, Math.max(1, Math.round(constNum(expr.period, rt))));
      return rollingAgg(src, period, expr.fn);
    }
    case "shift": {
      const src = getSeries(expr.src, rt);
      const off = Math.max(0, Math.round(expr.offset));
      if (!off) return src;
      const out = new Array<number>(n).fill(NaN);
      for (let idx = off; idx < n; idx += 1) out[idx] = src[idx - off];
      return out;
    }
  }
}

type AggFn = "sum" | "avg" | "min" | "max" | "stdev" | "median";

function rollingAgg(src: number[], period: number, fn: AggFn): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i += 1) {
    const win = src.slice(i - period + 1, i + 1);
    if (win.some(Number.isNaN)) continue;
    out[i] = aggregate(win, fn);
  }
  return out;
}

function aggregate(win: number[], fn: AggFn): number {
  switch (fn) {
    case "sum": return win.reduce((a, b) => a + b, 0);
    case "avg": return win.reduce((a, b) => a + b, 0) / win.length;
    case "min": return win.reduce((a, b) => Math.min(a, b), Infinity);
    case "max": return win.reduce((a, b) => Math.max(a, b), -Infinity);
    case "stdev": {
      const m = win.reduce((a, b) => a + b, 0) / win.length;
      return Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / win.length);
    }
    case "median": {
      const s = [...win].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
  }
}

function applyArith(op: "+" | "-" | "*" | "/" | "%" | "^", a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? NaN : a / b;
    case "%": return b === 0 ? NaN : a % b;
    case "^": return a ** b;
  }
}

function applyUnary(op: "neg" | "abs" | "round" | "floor" | "ceil" | "sign" | "log" | "log10" | "exp" | "sqrt", a: number): number {
  switch (op) {
    case "neg": return -a;
    case "abs": return Math.abs(a);
    case "round": return Math.round(a);
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "sign": return Math.sign(a);
    case "log": return Math.log(a);
    case "log10": return Math.log10(a);
    case "exp": return Math.exp(a);
    case "sqrt": return Math.sqrt(a);
  }
}

/** Wilder's RMA (used by ta.rma / RSI / ATR): alpha = 1/period, seeded by SMA. */
function wilderRma(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let seed = 0;
  let count = 0;
  let prev = NaN;
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      count += 1;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
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
