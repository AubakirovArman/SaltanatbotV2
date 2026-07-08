import type { Candle } from "../types";
import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";
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
} from "./ta";

export interface BacktestConfig {
  initialCapital: number;
  commissionPct: number;
  slippagePct: number;
  allowShort: boolean;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10_000,
  commissionPct: 0.05,
  slippagePct: 0.02,
  allowShort: true
};

export interface Trade {
  direction: "long" | "short";
  entryIndex: number;
  exitIndex: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  reason: "signal" | "stop" | "target" | "close";
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface TradeMarker {
  time: number;
  price: number;
  kind: "buy" | "sell" | "exit";
  label?: string;
}

export interface BacktestMetrics {
  netProfit: number;
  netProfitPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: number;
  avgTrade: number;
  expectancy: number;
  timeInMarketPct: number;
  finalEquity: number;
}

export interface BacktestResult {
  name: string;
  trades: Trade[];
  equityCurve: EquityPoint[];
  /** Flat entry/exit markers (kept for compatibility / report). */
  markers: TradeMarker[];
  /** Arrow signals from `signal_marker` blocks (no trade). */
  signals: TradeMarker[];
  alerts: { time: number; message: string }[];
  metrics: BacktestMetrics;
}

interface Runtime {
  candles: Candle[];
  n: number;
  params: Map<string, number>;
  vars: Map<string, number>;
  seriesCache: Map<string, number[]>;
  atr14: number[];
}

interface Position {
  dir: "long" | "short";
  qty: number;
  entryPrice: number;
  entryIndex: number;
  entryTime: number;
  stopPrice?: number;
  targetPrice?: number;
  trail?: { mode: "percent" | "atr"; value: number };
}

interface Intents {
  entry?: "long" | "short";
  exit: boolean;
  stop?: { mode: "price" | "percent" | "atr"; value: number };
  target?: { mode: "price" | "percent" | "atr"; value: number };
  trail?: { mode: "percent" | "atr"; value: number };
  size?: { mode: "units" | "equity_pct" | "risk_pct"; value: number };
  alerts: { message: string }[];
  markers: { dir: "up" | "down"; label: string }[];
}

export function runBacktest(ir: StrategyIR, candles: Candle[], config: BacktestConfig = DEFAULT_CONFIG): BacktestResult {
  const rt: Runtime = {
    candles,
    n: candles.length,
    params: new Map(ir.inputs.map((input) => [input.name, input.value])),
    vars: new Map(),
    seriesCache: new Map(),
    atr14: candles.length ? atrSeries(candles, 14) : []
  };

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const markers: TradeMarker[] = [];
  const signals: TradeMarker[] = [];
  const alerts: { time: number; message: string }[] = [];

  let equity = config.initialCapital;
  let position: Position | null = null;
  let sizing: Intents["size"] = { mode: "equity_pct", value: 100 };
  let barsInMarket = 0;

  const closePosition = (index: number, price: number, reason: Trade["reason"]) => {
    if (!position) return;
    const gross = position.dir === "long" ? position.qty * (price - position.entryPrice) : position.qty * (position.entryPrice - price);
    const commission = position.qty * (position.entryPrice + price) * (config.commissionPct / 100);
    const pnl = gross - commission;
    equity += pnl;
    trades.push({
      direction: position.dir,
      entryIndex: position.entryIndex,
      exitIndex: index,
      entryTime: position.entryTime,
      exitTime: candles[index].time,
      entryPrice: position.entryPrice,
      exitPrice: price,
      qty: position.qty,
      pnl,
      pnlPct: (pnl / (position.entryPrice * position.qty || 1)) * 100,
      reason
    });
    markers.push({ time: candles[index].time, price, kind: "exit", label: `Exit ${price.toFixed(2)}` });
    position = null;
  };

  for (let i = 0; i < rt.n; i += 1) {
    const candle = candles[i];

    // 1. Trailing stop ratchets with price, then intrabar stop / target
    //    (stops checked first) on bars after entry.
    if (position && i > position.entryIndex) {
      if (position.trail) {
        const atr = rt.atr14[i] || 0;
        if (position.dir === "long") {
          const candidate = position.trail.mode === "percent"
            ? candle.high * (1 - position.trail.value / 100)
            : candle.high - atr * position.trail.value;
          position.stopPrice = Math.max(position.stopPrice ?? -Infinity, candidate);
        } else {
          const candidate = position.trail.mode === "percent"
            ? candle.low * (1 + position.trail.value / 100)
            : candle.low + atr * position.trail.value;
          position.stopPrice = Math.min(position.stopPrice ?? Infinity, candidate);
        }
      }
      if (position.stopPrice !== undefined && stopHit(position, candle)) {
        closePosition(i, position.stopPrice, "stop");
      } else if (position && position.targetPrice !== undefined && targetHit(position, candle)) {
        closePosition(i, position.targetPrice, "target");
      }
    }

    // 2. Evaluate the strategy body to gather intents for this bar.
    const intents: Intents = { exit: false, alerts: [], markers: [] };
    execStatements(ir.body, i, rt, intents);
    if (intents.size) sizing = intents.size;
    for (const alert of intents.alerts) alerts.push({ time: candle.time, message: alert.message });
    for (const marker of intents.markers) {
      signals.push({
        time: candle.time,
        price: marker.dir === "up" ? candle.low : candle.high,
        kind: marker.dir === "up" ? "buy" : "sell",
        label: marker.label || undefined
      });
    }

    // 3. Signal exit at close.
    if (position && intents.exit) {
      closePosition(i, applySlippage(candle.close, position.dir, false, config), "signal");
    }

    // 4. Entry at close when flat.
    if (!position && intents.entry) {
      const dir = intents.entry;
      if (dir === "short" && !config.allowShort) {
        // skip disallowed shorts
      } else {
        const fill = applySlippage(candle.close, dir, true, config);
        let stopPrice = intents.stop ? resolveStop(dir, fill, intents.stop, rt.atr14[i]) : undefined;
        if (intents.trail && stopPrice === undefined) {
          // Seed the trailing stop from the entry bar so risk is bounded immediately.
          const atr = rt.atr14[i] || 0;
          stopPrice = intents.trail.mode === "percent"
            ? (dir === "long" ? fill * (1 - intents.trail.value / 100) : fill * (1 + intents.trail.value / 100))
            : (dir === "long" ? fill - atr * intents.trail.value : fill + atr * intents.trail.value);
        }
        const targetPrice = intents.target ? resolveTarget(dir, fill, intents.target, rt.atr14[i]) : undefined;
        const qty = resolveSize(sizing, equity, fill, stopPrice);
        if (qty > 0 && Number.isFinite(qty)) {
          position = { dir, qty, entryPrice: fill, entryIndex: i, entryTime: candle.time, stopPrice, targetPrice, trail: intents.trail };
          markers.push({
            time: candle.time,
            price: fill,
            kind: dir === "long" ? "buy" : "sell",
            label: `${dir === "long" ? "Long" : "Short"} ${fill.toFixed(2)}`
          });
        }
      }
    }

    if (position) barsInMarket += 1;
    equityCurve.push({ time: candle.time, equity: equity + unrealized(position, candle.close) });
  }

  // Close any open position at the last bar for reporting.
  if (position && rt.n > 0) {
    closePosition(rt.n - 1, candles[rt.n - 1].close, "close");
    equityCurve[equityCurve.length - 1] = { time: candles[rt.n - 1].time, equity };
  }

  return {
    name: ir.name,
    trades,
    equityCurve,
    markers,
    signals,
    alerts,
    metrics: computeMetrics(trades, equityCurve, config, barsInMarket, rt.n, candles)
  };
}

export interface PlotSeries {
  label: string;
  color: string;
  points: { time: number; value: number }[];
}

/**
 * Analyse a strategy on history WITHOUT position gating: return every plotted
 * indicator line and every bar where an entry / exit / marker condition fires.
 * This is what "add strategy to chart" shows — the lines it uses and all the
 * signal points, so you can see how it would have triggered.
 */
export function previewStrategy(ir: StrategyIR, candles: Candle[]): { plots: PlotSeries[]; signals: TradeMarker[] } {
  const rt: Runtime = {
    candles,
    n: candles.length,
    params: new Map(ir.inputs.map((input) => [input.name, input.value])),
    vars: new Map(),
    seriesCache: new Map(),
    atr14: candles.length ? atrSeries(candles, 14) : []
  };
  const plots: PlotSeries[] = [];
  const signals: TradeMarker[] = [];

  const walk = (stmts: Stmt[]) => {
    for (const stmt of stmts) {
      if (stmt.k === "plot") {
        const series = getSeries(stmt.value, rt);
        plots.push({
          label: stmt.label,
          color: stmt.color,
          points: candles.map((candle, i) => ({ time: candle.time, value: series[i] })).filter((point) => Number.isFinite(point.value))
        });
      } else if (stmt.k === "entry") {
        for (let i = 1; i < candles.length; i += 1) {
          if (evalBool(stmt.when, i, rt)) {
            signals.push({ time: candles[i].time, price: stmt.direction === "long" ? candles[i].low : candles[i].high, kind: stmt.direction === "long" ? "buy" : "sell", label: stmt.direction === "long" ? "Buy" : "Sell" });
          }
        }
      } else if (stmt.k === "exit") {
        for (let i = 1; i < candles.length; i += 1) {
          if (evalBool(stmt.when, i, rt)) signals.push({ time: candles[i].time, price: candles[i].high, kind: "exit", label: "Exit" });
        }
      } else if (stmt.k === "marker") {
        for (let i = 1; i < candles.length; i += 1) {
          if (evalBool(stmt.when, i, rt)) signals.push({ time: candles[i].time, price: stmt.dir === "up" ? candles[i].low : candles[i].high, kind: stmt.dir === "up" ? "buy" : "sell", label: stmt.label });
        }
      } else if (stmt.k === "if") {
        walk(stmt.then);
      }
    }
  };
  walk(ir.body);
  return { plots, signals };
}

// ---------- statement execution ----------

function execStatements(stmts: Stmt[], i: number, rt: Runtime, intents: Intents) {
  for (const stmt of stmts) execStatement(stmt, i, rt, intents);
}

function execStatement(stmt: Stmt, i: number, rt: Runtime, intents: Intents) {
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
    case "marker":
      if (evalBool(stmt.when, i, rt)) intents.markers.push({ dir: stmt.dir, label: stmt.label });
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
    case "plot":
      break;
    case "if":
      if (evalBool(stmt.cond, i, rt)) execStatements(stmt.then, i, rt, intents);
      break;
  }
}

// ---------- expression evaluation ----------

function evalNum(expr: NumExpr, i: number, rt: Runtime): number {
  switch (expr.k) {
    case "var":
      return rt.vars.get(expr.name) ?? 0;
    case "arith": {
      const a = evalNum(expr.a, i, rt);
      const b = evalNum(expr.b, i, rt);
      switch (expr.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? NaN : a / b;
        case "%": return b === 0 ? NaN : a % b;
      }
      return NaN;
    }
    case "unary": {
      const a = evalNum(expr.a, i, rt);
      switch (expr.op) {
        case "neg": return -a;
        case "abs": return Math.abs(a);
        case "round": return Math.round(a);
        case "floor": return Math.floor(a);
        case "ceil": return Math.ceil(a);
      }
      return a;
    }
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

/** Vectorize a pure numeric expression into an aligned series (memoized). */
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

/** Fold a numeric expression to a constant (for indicator periods). NaN if dynamic. */
function constNum(expr: NumExpr, rt: Runtime): number {
  switch (expr.k) {
    case "num": return expr.v;
    case "input": return rt.params.get(expr.name) ?? NaN;
    case "arith": return applyArith(expr.op, constNum(expr.a, rt), constNum(expr.b, rt));
    case "unary": return applyUnary(expr.op, constNum(expr.a, rt));
    default: return NaN;
  }
}

// ---------- broker helpers ----------

function applySlippage(price: number, dir: "long" | "short", entering: boolean, config: BacktestConfig): number {
  const worseUp = (dir === "long") === entering; // long entry & short exit fill higher
  const factor = worseUp ? 1 + config.slippagePct / 100 : 1 - config.slippagePct / 100;
  return price * factor;
}

function resolveStop(dir: "long" | "short", entry: number, stop: NonNullable<Intents["stop"]>, atr: number): number {
  if (stop.mode === "price") return stop.value;
  if (stop.mode === "percent") return dir === "long" ? entry * (1 - stop.value / 100) : entry * (1 + stop.value / 100);
  const distance = (atr || 0) * stop.value;
  return dir === "long" ? entry - distance : entry + distance;
}

function resolveTarget(dir: "long" | "short", entry: number, target: NonNullable<Intents["target"]>, atr: number): number {
  if (target.mode === "price") return target.value;
  if (target.mode === "percent") return dir === "long" ? entry * (1 + target.value / 100) : entry * (1 - target.value / 100);
  const distance = (atr || 0) * target.value;
  return dir === "long" ? entry + distance : entry - distance;
}

function resolveSize(sizing: NonNullable<Intents["size"]>, equity: number, price: number, stopPrice?: number): number {
  if (sizing.mode === "units") return sizing.value;
  if (sizing.mode === "risk_pct") {
    if (stopPrice !== undefined && Math.abs(price - stopPrice) > 0) {
      return (equity * (sizing.value / 100)) / Math.abs(price - stopPrice);
    }
    return (equity * 1.0) / price; // no stop → fall back to full equity notional
  }
  return (equity * (sizing.value / 100)) / price;
}

function stopHit(position: Position, candle: Candle): boolean {
  if (position.stopPrice === undefined) return false;
  return position.dir === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
}

function targetHit(position: Position, candle: Candle): boolean {
  if (position.targetPrice === undefined) return false;
  return position.dir === "long" ? candle.high >= position.targetPrice : candle.low <= position.targetPrice;
}

function unrealized(position: Position | null, price: number): number {
  if (!position) return 0;
  return position.dir === "long" ? position.qty * (price - position.entryPrice) : position.qty * (position.entryPrice - price);
}

// ---------- metrics ----------

function computeMetrics(
  trades: Trade[],
  equityCurve: EquityPoint[],
  config: BacktestConfig,
  barsInMarket: number,
  n: number,
  candles: Candle[]
): BacktestMetrics {
  const finalEquity = equityCurve.at(-1)?.equity ?? config.initialCapital;
  const netProfit = finalEquity - config.initialCapital;
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));

  let peak = equityCurve[0]?.equity ?? config.initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    }
  }

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }
  const meanReturn = mean(returns);
  const stdReturn = std(returns, meanReturn);
  const barMs = candles.length > 1 ? medianDelta(candles) : 60_000;
  const barsPerYear = (365 * 24 * 3600 * 1000) / barMs;
  const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(barsPerYear) : 0;

  return {
    netProfit,
    netProfitPct: (netProfit / config.initialCapital) * 100,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    maxDrawdownPct,
    sharpe,
    avgTrade: trades.length ? netProfit / trades.length : 0,
    expectancy: trades.length ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length : 0,
    timeInMarketPct: n > 0 ? (barsInMarket / n) * 100 : 0,
    finalEquity
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function medianDelta(candles: Candle[]): number {
  const deltas: number[] = [];
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i += 1) {
    deltas.push(candles[i].time - candles[i - 1].time);
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || 60_000;
}
