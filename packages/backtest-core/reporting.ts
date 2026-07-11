import type { Position } from "./broker.js";
import type { Trade } from "./types.js";

export interface VariableTracePoint {
  time: number;
  vars: Record<string, number>;
}

export interface VariableTraceCollector {
  capture(index: number, time: number, variables: Map<string, number>): void;
  result(): VariableTracePoint[] | undefined;
}

/** Build the position, PnL and daily-stat context consumed by StrategyIR `ctx` nodes. */
export function buildEvaluationContext(
  position: Position | null,
  price: number,
  index: number,
  trades: Trade[],
  equity: number,
  barTime: number
): Record<string, number> {
  let consecutiveLosses = 0;
  for (let tradeIndex = trades.length - 1; tradeIndex >= 0; tradeIndex -= 1) {
    if (trades[tradeIndex].pnl < 0) consecutiveLosses += 1;
    else break;
  }

  const dayStart = Math.floor(barTime / 86_400_000) * 86_400_000;
  let tradesToday = 0;
  let realizedToday = 0;
  for (const trade of trades) {
    if (trade.exitTime >= dayStart && trade.exitTime <= barTime) {
      tradesToday += 1;
      realizedToday += trade.pnl;
    }
  }

  const context: Record<string, number> = {
    last_trade_pnl: trades.at(-1)?.pnl ?? 0,
    consecutive_losses: consecutiveLosses,
    trades_today: tradesToday,
    realized_today: realizedToday,
    equity
  };
  if (position) {
    const move = position.dir === "long" ? price - position.entryPrice : position.entryPrice - price;
    context.position_dir = position.dir === "long" ? 1 : -1;
    context.entry_price = position.entryPrice;
    context.unrealized_pnl = position.qty * move;
    context.unrealized_pnl_pct = position.entryPrice ? (move / position.entryPrice) * 100 : 0;
    context.bars_in_position = index - position.entryIndex;
  }
  return context;
}

/** Keep a deterministic bounded trace while always retaining the final bar. */
export function createVariableTraceCollector(totalBars: number, maxPoints = 600): VariableTraceCollector {
  const points: VariableTracePoint[] = [];
  const safeMax = Math.max(1, Math.floor(maxPoints));
  const step = Math.max(1, Math.ceil(totalBars / safeMax));

  return {
    capture(index, time, variables) {
      if (variables.size === 0 || (index % step !== 0 && index !== totalBars - 1)) return;
      points.push({ time, vars: Object.fromEntries(variables) });
      if (points.length > safeMax) points.splice(1, points.length - safeMax);
    },
    result() {
      return points.length > 0 ? points : undefined;
    }
  };
}
