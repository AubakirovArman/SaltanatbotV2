import type { Candle } from "../types";
import {
  beginStrategyBar,
  createStrategyRuntime,
  evaluateCondition as evaluateCoreCondition,
  evaluateNumber as evaluateCoreNumber,
  evaluateStrategyBar,
  MAX_OPS_PER_BAR,
  MAX_REPEAT,
  runStrategyInit,
  type BarIntents,
  type SecurityDataContext,
  type StrategyRuntime
} from "@saltanatbotv2/strategy-core";
import { computeBacktestMetrics, medianDelta } from "./backtestMetrics";
import type { BacktestConfig, BacktestResult, EquityPoint, TestedRange, Trade, TradeMarker } from "./backtestTypes";
import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";
import { buildPreviewTables, type PreviewTable } from "./previewTables";
import { atr as atrSeries } from "./ta";

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10_000,
  commissionPct: 0.05,
  slippagePct: 0.02,
  allowShort: true,
  fillTiming: "next_open",
  maxLeverage: 5,
  qtyStep: 0,
  fundingRatePctPer8h: 0
};

export type { BacktestConfig, BacktestMetrics, BacktestResult, EquityPoint, TestedRange, Trade, TradeMarker } from "./backtestTypes";

interface Runtime extends StrategyRuntime {
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
  /** Worst / best unrealised PnL seen while open (absolute currency). */
  maeAbs: number;
  mfeAbs: number;
}

type Intents = BarIntents;

export function runBacktest(ir: StrategyIR, candles: Candle[], config: BacktestConfig = DEFAULT_CONFIG, securityData?: SecurityDataContext): BacktestResult {
  // Merge caller config over defaults so new optional fields always have a value.
  const cfg: Required<BacktestConfig> = { ...DEFAULT_CONFIG, ...config } as Required<BacktestConfig>;
  const nextOpen = cfg.fillTiming !== "same_close";

  const rt: Runtime = {
    ...createStrategyRuntime(ir, candles, { securityData }),
    atr14: candles.length ? atrSeries(candles, 14) : [],
  };
  runStrategyInit(ir, rt);

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const markers: TradeMarker[] = [];
  const signals: TradeMarker[] = [];
  const alerts: { time: number; message: string }[] = [];
  const warnings: { time: number; message: string }[] = [];

  let equity = config.initialCapital;
  let position: Position | null = null;
  let sizing: Intents["size"] = { mode: "equity_pct", value: 100 };
  let barsInMarket = 0;
  let liquidated = false;
  let fundingPaid = 0;
  let budgetWarned = false;
  const varTrace: { time: number; vars: Record<string, number> }[] = [];
  const traceStep = Math.max(1, Math.floor(rt.n / 600)); // cap the trace at ~600 points

  // Bar duration (ms) inferred from the candle spacing — the same value used to
  // annualise Sharpe. Funding is pro-rated to this bar length: a rate quoted per
  // 8h applies over `barMs / 8h` of that period each bar a position is open.
  const EIGHT_HOURS_MS = 8 * 3600 * 1000;
  const barMs = rt.n > 1 ? medianDelta(candles) : 60_000;
  const fundingBarFraction = (cfg.fundingRatePctPer8h / 100) * (barMs / EIGHT_HOURS_MS);

  // Warm-up: indicators are NaN until enough history accrues. Metrics/equity are
  // only measured from `warmup` onward so the flat opening bars don't dilute
  // Sharpe / time-in-market / drawdown denominators.
  const warmup = Math.min(rt.n, computeWarmup(ir));

  const closePosition = (index: number, price: number, reason: Trade["reason"]) => {
    if (!position) return;
    const gross = position.dir === "long" ? position.qty * (price - position.entryPrice) : position.qty * (position.entryPrice - price);
    const commission = position.qty * (position.entryPrice + price) * (config.commissionPct / 100);
    const pnl = gross - commission;
    equity += pnl;
    const notional = position.entryPrice * position.qty || 1;
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
      pnlPct: (pnl / notional) * 100,
      reason,
      barsHeld: index - position.entryIndex,
      maePct: (position.maeAbs / notional) * 100,
      mfePct: (position.mfeAbs / notional) * 100
    });
    markers.push({ time: candles[index].time, price, kind: "exit", label: `Exit ${price.toFixed(2)}` });
    position = null;
  };

  // Pending signal fill carried to the next bar's open (next_open timing).
  let pendingEntry: { dir: "long" | "short"; stop: Intents["stop"]; target: Intents["target"]; trail: Intents["trail"]; size: NonNullable<Intents["size"]> } | null = null;
  let pendingExit = false;

  // Returns the opened position (or null if the entry was skipped/rejected).
  const openPosition = (dir: "long" | "short", fill: number, index: number, stopI: Intents["stop"], targetI: Intents["target"], trailI: Intents["trail"], size: NonNullable<Intents["size"]>): Position | null => {
    let stopPrice = stopI ? resolveStop(dir, fill, stopI, rt.atr14[index]) : undefined;
    if (trailI && stopPrice === undefined) {
      // Seed the trailing stop from the entry bar so risk is bounded immediately.
      const atr = rt.atr14[index] || 0;
      stopPrice = trailI.mode === "percent"
        ? (dir === "long" ? fill * (1 - trailI.value / 100) : fill * (1 + trailI.value / 100))
        : (dir === "long" ? fill - atr * trailI.value : fill + atr * trailI.value);
    }
    const targetPrice = targetI ? resolveTarget(dir, fill, targetI, rt.atr14[index]) : undefined;
    const sized = resolveSize(size, equity, fill, stopPrice, cfg);
    if (sized.warning) warnings.push({ time: candles[index].time, message: sized.warning });
    const qty = sized.qty;
    if (qty > 0 && Number.isFinite(qty)) {
      markers.push({
        time: candles[index].time,
        price: fill,
        kind: dir === "long" ? "buy" : "sell",
        label: `${dir === "long" ? "Long" : "Short"} ${fill.toFixed(2)}`
      });
      return { dir, qty, entryPrice: fill, entryIndex: index, entryTime: candles[index].time, stopPrice, targetPrice, trail: trailI, maeAbs: 0, mfeAbs: 0 };
    }
    return null;
  };

  for (let i = 0; i < rt.n; i += 1) {
    const candle = candles[i];

    // 0. Fill any signal intent carried from the previous bar at THIS bar's open
    //    (next_open timing — mirrors the live engine acting only after a close).
    if (nextOpen) {
      if (position && pendingExit) {
        closePosition(i, applySlippage(candle.open, position.dir, false, cfg), "signal");
      }
      pendingExit = false;
      if (!position && pendingEntry) {
        const fill = applySlippage(candle.open, pendingEntry.dir, true, cfg);
        position = openPosition(pendingEntry.dir, fill, i, pendingEntry.stop, pendingEntry.target, pendingEntry.trail, pendingEntry.size);
      }
      pendingEntry = null;
    }

    // 1. Intrabar stop / target from the entry bar onward.
    //    Intrabar assumption: we have NO path knowledge within a bar. We assume
    //    the STOP is reached before the TARGET (pessimistic), and we test the
    //    stop as it stood at BAR OPEN — the trail only ratchets forward for the
    //    NEXT bar, avoiding the look-ahead of ratcheting on this bar's high/low
    //    and then testing this bar's low/high against the tightened stop.
    if (position && i >= position.entryIndex) {
      if (position.stopPrice !== undefined && stopHit(position, candle)) {
        // Gap-aware: if price gaps through the stop, the real fill is the open,
        // not the stop level. Stops are MARKET orders → apply slippage.
        const raw = position.dir === "long" ? Math.min(candle.open, position.stopPrice) : Math.max(candle.open, position.stopPrice);
        closePosition(i, applySlippage(raw, position.dir, false, cfg), "stop");
      } else if (position && position.targetPrice !== undefined && targetHit(position, candle)) {
        // Targets are LIMIT orders → fill at the limit, but gap-aware in the
        // favourable direction (a gap through the limit fills at the better open).
        const raw = position.dir === "long" ? Math.max(candle.open, position.targetPrice) : Math.min(candle.open, position.targetPrice);
        closePosition(i, raw, "target");
      }
      // Ratchet the trailing stop from THIS bar's extreme for use on the NEXT bar.
      if (position && position.trail) {
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
    }

    // 1b. Track MAE / MFE and simulate liquidation against intrabar extremes.
    if (position) {
      const worstPrice = position.dir === "long" ? candle.low : candle.high;
      const bestPrice = position.dir === "long" ? candle.high : candle.low;
      const worst = unrealized(position, worstPrice);
      const best = unrealized(position, bestPrice);
      position.maeAbs = Math.min(position.maeAbs, worst);
      position.mfeAbs = Math.max(position.mfeAbs, best);
      // Liquidation: if realised equity + worst-case unrealised is wiped out,
      // force-close at the point equity hits zero and stop trading.
      if (equity + worst <= 0) {
        warnings.push({ time: candle.time, message: "Account liquidated — equity reached zero." });
        closePosition(i, worstPrice, "liquidation");
        liquidated = true;
      }
    }

    // 2. Evaluate the strategy body to gather intents for this bar.
    const ctx = buildCtx(position, candle.close, i, trades, equity, candle.time);
    const intents: Intents = liquidated
      ? { exit: false, alerts: [], markers: [] }
      : evaluateStrategyBar(ir, i, rt, ctx);
    if (intents.budgetExceeded && !budgetWarned) {
      warnings.push({ time: candle.time, message: `A loop hit the per-bar execution budget (${MAX_OPS_PER_BAR}) and was truncated.` });
      budgetWarned = true;
    }
    if (rt.vars.size && (i % traceStep === 0 || i === rt.n - 1)) {
      varTrace.push({ time: candle.time, vars: Object.fromEntries(rt.vars) });
    }
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

    if (!liquidated) {
      if (nextOpen) {
        // Carry intent; it fills at the NEXT bar's open (or is dropped at end of data).
        if (position && intents.exit) pendingExit = true;
        if (!position && intents.entry && !pendingExit) {
          const dir = intents.entry;
          if (dir === "short" && !cfg.allowShort) {
            // skip disallowed shorts
          } else {
            pendingEntry = { dir, stop: intents.stop, target: intents.target, trail: intents.trail, size: sizing };
          }
        }
      } else {
        // Legacy same-close timing: fill on this bar's close.
        if (position && intents.exit) {
          closePosition(i, applySlippage(candle.close, position.dir, false, cfg), "signal");
        }
        if (!position && intents.entry) {
          const dir = intents.entry;
          if (dir === "short" && !cfg.allowShort) {
            // skip disallowed shorts
          } else {
            const fill = applySlippage(candle.close, dir, true, cfg);
            position = openPosition(dir, fill, i, intents.stop, intents.target, intents.trail, sizing);
          }
        }
      }
    }

    if (position) {
      barsInMarket += 1;
      // Accrue funding / borrow cost for holding this bar, charged against the
      // position's notional at the bar close and deducted from realised equity.
      if (fundingBarFraction !== 0) {
        const cost = position.qty * candle.close * fundingBarFraction;
        if (Number.isFinite(cost) && cost !== 0) {
          equity -= cost;
          fundingPaid += cost;
        }
      }
    }
    equityCurve.push({ time: candle.time, equity: equity + unrealized(position, candle.close) });
  }

  // Close any open position at the last bar for reporting (slippage on the forced close).
  if (position && rt.n > 0) {
    closePosition(rt.n - 1, applySlippage(candles[rt.n - 1].close, position.dir, false, cfg), "close");
    equityCurve[equityCurve.length - 1] = { time: candles[rt.n - 1].time, equity };
  }

  // Restrict the measured equity curve to the post-warm-up window. Trades are
  // already gated by warm-up (indicators are NaN, so no entries fire earlier).
  const measured = equityCurve.slice(warmup);
  const tested: TestedRange = {
    fromTime: measured[0]?.time ?? candles[0]?.time ?? 0,
    toTime: measured.at(-1)?.time ?? candles.at(-1)?.time ?? 0,
    bars: measured.length,
    warmupBars: warmup
  };

  return {
    name: ir.name,
    trades,
    equityCurve,
    markers,
    signals,
    alerts,
    warnings,
    metrics: computeBacktestMetrics(trades, measured, config, barsInMarket, measured.length, candles, liquidated, fundingPaid),
    tested,
    varTrace: varTrace.length ? varTrace : undefined
  };
}

/**
 * Estimate the indicator warm-up (max lookback) of a strategy from its IR by
 * walking every expression and taking the largest constant period. Dynamic
 * periods can't be folded, so we fall back to a safe default of 200 bars.
 */
function computeWarmup(ir: StrategyIR): number {
  const params = new Map(ir.inputs.map((input) => [input.name, input.value]));
  const SAFE_DEFAULT = 200;
  let dynamic = false;

  const foldConst = (expr: NumExpr): number => {
    switch (expr.k) {
      case "num": return expr.v;
      case "input": return params.get(expr.name) ?? NaN;
      case "arith": {
        const a = foldConst(expr.a);
        const b = foldConst(expr.b);
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
        const a = foldConst(expr.a);
        switch (expr.op) {
          case "neg": return -a;
          case "abs": return Math.abs(a);
          case "round": return Math.round(a);
          case "floor": return Math.floor(a);
          case "ceil": return Math.ceil(a);
        }
        return a;
      }
      default: return NaN;
    }
  };

  const period = (expr: NumExpr): number => {
    const v = foldConst(expr);
    if (!Number.isFinite(v)) { dynamic = true; return 0; }
    return Math.max(1, Math.round(v));
  };

  let max = 0;
  const visitNum = (expr: NumExpr) => {
    switch (expr.k) {
      case "price":
        if (expr.offset) max = Math.max(max, expr.offset);
        break;
      case "time":
        break;
      case "security":
        dynamic = true;
        visitNum(expr.source);
        break;
      case "ma": case "rsi": case "atr": case "stdev": case "extreme": case "change":
      case "wpr": case "cci": case "roc":
        max = Math.max(max, period(expr.period));
        if ("source" in expr) visitNum(expr.source);
        break;
      case "bollinger":
        max = Math.max(max, period(expr.period));
        visitNum(expr.source);
        break;
      case "macd":
        max = Math.max(max, period(expr.slow) + period(expr.signal));
        visitNum(expr.source);
        break;
      case "stoch":
        max = Math.max(max, period(expr.period) + period(expr.smooth));
        break;
      case "minmax": case "arith":
        visitNum(expr.a); visitNum(expr.b);
        break;
      case "unary":
        visitNum(expr.a);
        break;
      // wave 3: unbounded-lookback nodes force the safe-default warmup.
      case "barindex": case "vwap":
        dynamic = true;
        break;
      case "valuewhen":
        dynamic = true;
        visitBool(expr.cond); visitNum(expr.src);
        break;
      case "sar":
        dynamic = true;
        visitNum(expr.start); visitNum(expr.inc); visitNum(expr.max);
        break;
      // wave 3: fixed-window nodes contribute their period.
      case "extremebars": case "linreg": case "cmo": case "alma": case "cog": case "percentrank":
        max = Math.max(max, period(expr.period));
        visitNum(expr.source);
        break;
      case "mfi":
        max = Math.max(max, period(expr.period));
        break;
      case "supertrend":
        max = Math.max(max, period(expr.period));
        visitNum(expr.factor);
        break;
      case "dmi":
        max = Math.max(max, period(expr.period) + period(expr.smoothing));
        break;
      case "kc":
        max = Math.max(max, period(expr.period));
        visitNum(expr.mult);
        break;
      case "tsi":
        max = Math.max(max, period(expr.short) + period(expr.long));
        visitNum(expr.source);
        break;
      case "correlation":
        max = Math.max(max, period(expr.period));
        visitNum(expr.a); visitNum(expr.b);
        break;
    }
  };
  const visitBool = (expr: BoolExpr) => {
    switch (expr.k) {
      case "compare": case "cross":
        visitNum(expr.a); visitNum(expr.b);
        break;
      case "logic":
        visitBool(expr.a); visitBool(expr.b);
        break;
      case "not":
        visitBool(expr.a);
        break;
      case "trend":
        max = Math.max(max, period(expr.period));
        visitNum(expr.source);
        break;
      case "between":
        visitNum(expr.value); visitNum(expr.low); visitNum(expr.high);
        break;
    }
  };
  const walk = (stmts: Stmt[]) => {
    for (const stmt of stmts) {
      switch (stmt.k) {
        case "entry": case "exit": case "marker": case "alert": visitBool(stmt.when); break;
        case "stop": case "target": case "trail": case "size": case "setvar": visitNum(stmt.value); break;
        case "plot": visitNum(stmt.value); break;
        case "box": visitNum(stmt.top); visitNum(stmt.bottom); visitBool(stmt.when); break;
        case "projection": visitNum(stmt.left); visitNum(stmt.right); visitNum(stmt.top); visitNum(stmt.bottom); visitBool(stmt.when); break;
        case "metric": visitNum(stmt.value); visitBool(stmt.when); break;
        case "vline": visitBool(stmt.when); break;
        case "ray": visitNum(stmt.price); visitBool(stmt.when); break;
        case "if": visitBool(stmt.cond); walk(stmt.then); break;
      }
    }
  };
  walk(ir.body);

  if (dynamic) return SAFE_DEFAULT;
  return Math.max(max, 1);
}

export interface PlotSeries {
  label: string;
  color: string;
  points: { time: number; value: number }[];
  /** Where to draw: overlaid on the price pane (default) or in a separate sub-pane. */
  pane?: "price" | "sub";
}

/** A shaded rectangle over a run of consecutive bars. Non-finite top/bottom = the
 *  full pane height (bgcolor-style background shading). */
export interface ShapeBox {
  t1: number;
  t2: number;
  top: number;
  bottom: number;
  color: string;
  label?: string;
}
export interface ShapeVLine {
  time: number;
  color: string;
  label?: string;
}
/** A horizontal level anchored where its condition fired, extending right. */
export interface ShapeRay {
  time: number;
  price: number;
  color: string;
  label?: string;
}
export interface ShapeOverlays {
  boxes: ShapeBox[];
  vlines: ShapeVLine[];
  rays: ShapeRay[];
}

export type { PreviewTable } from "./previewTables";

/** Render-safety caps for drawing overlays (a hostile/buggy strategy can fire every bar). */
const MAX_BOXES = 500;
const MAX_VLINES = 500;
const MAX_RAYS = 200;

/**
 * Analyse a strategy on history WITHOUT position gating: return every plotted
 * indicator line and every bar where an entry / exit / marker condition fires.
 * This is what "add strategy to chart" shows — the lines it uses and all the
 * signal points, so you can see how it would have triggered.
 */
export function previewStrategy(ir: StrategyIR, candles: Candle[], securityData?: SecurityDataContext): { plots: PlotSeries[]; signals: TradeMarker[]; shapes: ShapeOverlays; tables: PreviewTable[] } {
  const rt: Runtime = {
    ...createStrategyRuntime(ir, candles, { securityData }),
    atr14: candles.length ? atrSeries(candles, 14) : [],
  };
  runStrategyInit(ir, rt);
  const signals: TradeMarker[] = [];
  const shapes: ShapeOverlays = { boxes: [], vlines: [], rays: [] };
  // Open box runs: one per box statement, extended while its condition stays true
  // on consecutive bars and flushed when the run breaks (or at the end of history).
  const boxRuns = new Map<Stmt, { t1: number; t2: number; top: number; bottom: number; lastBar: number }>();
  // Keep-NEWEST eviction: the most recent (on-screen) shapes matter most, so when
  // the cap overflows we drop the oldest instead of refusing new ones.
  const flushBox = (stmt: Extract<Stmt, { k: "box" }>, run: { t1: number; t2: number; top: number; bottom: number }) => {
    shapes.boxes.push({ t1: run.t1, t2: run.t2, top: run.top, bottom: run.bottom, color: stmt.color, label: stmt.label || undefined });
    if (shapes.boxes.length > MAX_BOXES) shapes.boxes.shift();
  };
  // One vline/ray per statement per bar — loop bodies re-execute statements.
  const drawnAtBar = new Map<Stmt, number>();
  const projections = new Map<Stmt, ShapeBox>();
  const metricValues = new Map<Stmt, number>();

  // Pre-register plots in AST order so their series keep a stable order even when
  // a plot lives inside an `if` that first fires on a late bar.
  const plotMap = new Map<Stmt, PlotSeries>();
  const registerPlots = (stmts: Stmt[]) => {
    for (const stmt of stmts) {
      if (stmt.k === "plot") plotMap.set(stmt, { label: stmt.label, color: stmt.color, points: [], pane: stmt.pane ?? "price" });
      else if (stmt.k === "if") {
        registerPlots(stmt.then);
        for (const clause of stmt.elifs ?? []) registerPlots(clause.then);
        if (stmt.else) registerPlots(stmt.else);
      } else if (stmt.k === "repeat" || stmt.k === "while") registerPlots(stmt.body);
    }
  };
  registerPlots(ir.body);

  // Execute bar-by-bar (statements in order) so `setvar` state accumulates and any
  // stateful expression previews exactly as it would in the backtest — walking
  // statement-by-statement (the old approach) never ran setvar and mis-ordered state.
  const execBar = (stmts: Stmt[], i: number) => {
    for (const stmt of stmts) {
      if (rt.ops >= MAX_OPS_PER_BAR) {
        rt.budgetHit = true;
        return;
      }
      rt.ops += 1;
      switch (stmt.k) {
        case "setvar":
          rt.vars.set(stmt.name, evalNum(stmt.value, i, rt));
          break;
        case "setvarb":
          rt.vars.set(stmt.name, evalBool(stmt.value, i, rt) ? 1 : 0);
          break;
        case "plot": {
          const value = evalNum(stmt.value, i, rt);
          if (Number.isFinite(value)) (plotMap.get(stmt) as PlotSeries).points.push({ time: candles[i].time, value });
          break;
        }
        case "entry":
          if (i >= 1 && evalBool(stmt.when, i, rt)) signals.push({ time: candles[i].time, price: stmt.direction === "long" ? candles[i].low : candles[i].high, kind: stmt.direction === "long" ? "buy" : "sell", label: stmt.direction === "long" ? "Buy" : "Sell" });
          break;
        case "exit":
          if (i >= 1 && evalBool(stmt.when, i, rt)) signals.push({ time: candles[i].time, price: candles[i].high, kind: "exit", label: "Exit" });
          break;
        case "marker":
          if (i >= 1 && evalBool(stmt.when, i, rt)) signals.push({ time: candles[i].time, price: stmt.dir === "up" ? candles[i].low : candles[i].high, kind: stmt.dir === "up" ? "buy" : "sell", label: stmt.label });
          break;
        case "box": {
          if (!evalBool(stmt.when, i, rt)) break;
          const top = evalNum(stmt.top, i, rt);
          const bottom = evalNum(stmt.bottom, i, rt);
          const run = boxRuns.get(stmt);
          if (run && (run.lastBar === i || run.lastBar === i - 1)) {
            run.t2 = candles[i].time;
            // Finite-aware extremes: warm-up NaNs are skipped instead of poisoning the
            // edge; runs whose edges are NaN on EVERY bar stay NaN (full-height shading).
            run.top = Number.isFinite(top) ? (Number.isFinite(run.top) ? Math.max(run.top, top) : top) : run.top;
            run.bottom = Number.isFinite(bottom) ? (Number.isFinite(run.bottom) ? Math.min(run.bottom, bottom) : bottom) : run.bottom;
            run.lastBar = i;
          } else {
            if (run) flushBox(stmt as Extract<Stmt, { k: "box" }>, run);
            boxRuns.set(stmt, { t1: candles[i].time, t2: candles[i].time, top, bottom, lastBar: i });
          }
          break;
        }
        case "projection": {
          if (!evalBool(stmt.when, i, rt)) break;
          const left = evalNum(stmt.left, i, rt);
          const right = evalNum(stmt.right, i, rt);
          const top = evalNum(stmt.top, i, rt);
          const bottom = evalNum(stmt.bottom, i, rt);
          if ([left, right, top, bottom].every(Number.isFinite)) {
            projections.set(stmt, { t1: left, t2: right, top, bottom, color: stmt.color, label: stmt.label || undefined });
          }
          break;
        }
        case "metric": {
          if (!evalBool(stmt.when, i, rt)) break;
          const value = evalNum(stmt.value, i, rt);
          if (Number.isFinite(value)) metricValues.set(stmt, value);
          break;
        }
        case "vline":
          if (evalBool(stmt.when, i, rt) && drawnAtBar.get(stmt) !== i) {
            drawnAtBar.set(stmt, i);
            shapes.vlines.push({ time: candles[i].time, color: stmt.color, label: stmt.label || undefined });
            if (shapes.vlines.length > MAX_VLINES) shapes.vlines.shift();
          }
          break;
        case "ray": {
          if (!evalBool(stmt.when, i, rt) || drawnAtBar.get(stmt) === i) break;
          const price = evalNum(stmt.price, i, rt);
          if (Number.isFinite(price)) {
            drawnAtBar.set(stmt, i);
            shapes.rays.push({ time: candles[i].time, price, color: stmt.color, label: stmt.label || undefined });
            if (shapes.rays.length > MAX_RAYS) shapes.rays.shift();
          }
          break;
        }
        case "if": {
          if (evalBool(stmt.cond, i, rt)) {
            execBar(stmt.then, i);
            break;
          }
          let matched = false;
          for (const clause of stmt.elifs ?? []) {
            if (evalBool(clause.cond, i, rt)) {
              execBar(clause.then, i);
              matched = true;
              break;
            }
          }
          if (!matched && stmt.else) execBar(stmt.else, i);
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
            execBar(stmt.body, i);
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
            execBar(stmt.body, i);
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
            execBar(stmt.body, i);
            iter += 1;
          }
          break;
        }
        // stop/target/trail/size/alert have no chart preview — skipped here.
      }
    }
  };
  for (let i = 0; i < candles.length; i += 1) {
    beginStrategyBar(rt);
    execBar(ir.body, i);
  }

  for (const [stmt, run] of boxRuns) flushBox(stmt as Extract<Stmt, { k: "box" }>, run);
  for (const box of projections.values()) {
    shapes.boxes.push(box);
    if (shapes.boxes.length > MAX_BOXES) shapes.boxes.shift();
  }

  const plots = [...plotMap.values()].filter((plot) => plot.points.length > 0);
  return { plots, signals, shapes, tables: buildPreviewTables(ir.body, metricValues) };
}

// ---------- statement execution ----------

/** Build the per-bar position/PnL context for `ctx` reads (identical shape to the live engine). */
function buildCtx(position: Position | null, price: number, i: number, trades: Trade[], equity: number, barTime: number): Record<string, number> {
  let consecutiveLosses = 0;
  for (let t = trades.length - 1; t >= 0; t -= 1) {
    if (trades[t].pnl < 0) consecutiveLosses += 1;
    else break;
  }
  const dayStart = Math.floor(barTime / 86_400_000) * 86_400_000;
  let tradesToday = 0;
  let realizedToday = 0;
  for (const tr of trades) {
    if (tr.exitTime >= dayStart) {
      tradesToday += 1;
      realizedToday += tr.pnl;
    }
  }
  const ctx: Record<string, number> = {
    last_trade_pnl: trades.at(-1)?.pnl ?? 0,
    consecutive_losses: consecutiveLosses,
    trades_today: tradesToday,
    realized_today: realizedToday,
    equity
  };
  if (position) {
    const move = position.dir === "long" ? price - position.entryPrice : position.entryPrice - price;
    ctx.position_dir = position.dir === "long" ? 1 : -1;
    ctx.entry_price = position.entryPrice;
    ctx.unrealized_pnl = position.qty * move;
    ctx.unrealized_pnl_pct = position.entryPrice ? (move / position.entryPrice) * 100 : 0;
    ctx.bars_in_position = i - position.entryIndex;
  }
  return ctx;
}

function evalNum(expr: NumExpr, i: number, rt: Runtime): number {
  return evaluateCoreNumber(expr, i, rt);
}

function evalBool(expr: BoolExpr, i: number, rt: Runtime): boolean {
  return evaluateCoreCondition(expr, i, rt);
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

interface SizeResult {
  qty: number;
  warning?: string;
}

function resolveSize(
  sizing: NonNullable<Intents["size"]>,
  equity: number,
  price: number,
  stopPrice: number | undefined,
  cfg: Required<BacktestConfig>
): SizeResult {
  if (price <= 0 || !Number.isFinite(price)) return { qty: 0 };

  let qty: number;
  if (sizing.mode === "units") {
    qty = sizing.value;
  } else if (sizing.mode === "risk_pct") {
    if (stopPrice !== undefined && Math.abs(price - stopPrice) > 0) {
      qty = (equity * (sizing.value / 100)) / Math.abs(price - stopPrice);
    } else {
      // No stop → risk is unbounded, so we can't size by risk. Skip the entry
      // rather than silently taking a ~100%-equity position (old behaviour).
      return { qty: 0, warning: "Skipped risk_pct entry: no stop set, so risk-based size is undefined." };
    }
  } else {
    qty = (equity * (sizing.value / 100)) / price;
  }

  if (!(qty > 0) || !Number.isFinite(qty)) return { qty: 0 };

  // Margin guardrail: cap notional at equity * maxLeverage.
  let warning: string | undefined;
  const maxNotional = equity * cfg.maxLeverage;
  if (price * qty > maxNotional && maxNotional > 0) {
    const capped = maxNotional / price;
    warning = `Position clipped to ${cfg.maxLeverage}x leverage (requested notional exceeded margin).`;
    qty = capped;
  }

  // Round quantity down to a sane step so fills aren't infinitely divisible.
  if (cfg.qtyStep > 0) {
    qty = Math.floor(qty / cfg.qtyStep) * cfg.qtyStep;
    if (!(qty > 0)) return { qty: 0, warning };
  }

  return { qty, warning };
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
