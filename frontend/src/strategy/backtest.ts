import type { Candle } from "../types";
import {
  createStrategyRuntime,
  evaluateStrategyBar,
  MAX_OPS_PER_BAR,
  runStrategyInit,
  type BarIntents,
  type SecurityDataContext,
  type StrategyRuntime
} from "@saltanatbotv2/strategy-core";
import { computeBacktestMetrics, medianDelta } from "./backtestMetrics";
import {
  applySlippage,
  resolveSize,
  resolveStop,
  resolveTarget,
  stopHit,
  targetHit,
  unrealized,
  type Position
} from "./backtest/broker";
import { estimateWarmupBars } from "./backtest/warmup";
import type { BacktestConfig, BacktestResult, EquityPoint, TestedRange, Trade, TradeMarker } from "./backtestTypes";
import type { StrategyIR } from "./ir";
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
export {
  previewStrategy,
  type PlotSeries,
  type ShapeBox,
  type ShapeOverlays,
  type ShapeRay,
  type ShapeVLine,
  type StrategyPreview
} from "./backtest/preview";
export type { PreviewTable } from "./previewTables";

interface Runtime extends StrategyRuntime {
  atr14: number[];
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
  const warmup = Math.min(rt.n, estimateWarmupBars(ir));

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

/** Build the per-bar position/PnL context for canonical `ctx` reads. */
function buildCtx(
  position: Position | null,
  price: number,
  i: number,
  trades: Trade[],
  equity: number,
  barTime: number
): Record<string, number> {
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
