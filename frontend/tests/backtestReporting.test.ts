import { describe, expect, it } from "vitest";
import {
  buildEvaluationContext,
  createVariableTraceCollector
} from "../src/strategy/backtest/reporting";
import type { Position } from "../src/strategy/backtest/broker";
import type { Trade } from "../src/strategy/backtestTypes";

const DAY = 86_400_000;

function trade(exitTime: number, pnl: number): Trade {
  return {
    direction: "long",
    entryIndex: 0,
    exitIndex: 1,
    entryTime: exitTime - 1,
    exitTime,
    entryPrice: 100,
    exitPrice: 100 + pnl,
    qty: 1,
    pnl,
    pnlPct: pnl,
    reason: "signal",
    barsHeld: 1,
    maePct: 0,
    mfePct: 0
  };
}

describe("backtest reporting context", () => {
  it("tracks consecutive losses and only completed trades from the current UTC day", () => {
    const now = DAY * 3 + 1000;
    const trades = [trade(DAY * 2, 5), trade(DAY * 3 + 100, -2), trade(DAY * 3 + 500, -3)];
    const context = buildEvaluationContext(null, 100, 10, trades, 12_000, now);

    expect(context).toMatchObject({
      last_trade_pnl: -3,
      consecutive_losses: 2,
      trades_today: 2,
      realized_today: -5,
      equity: 12_000
    });
    expect(context.position_dir).toBeUndefined();
  });

  it("adds directional position and unrealized PnL fields", () => {
    const position: Position = {
      dir: "short",
      qty: 2,
      entryPrice: 100,
      entryIndex: 4,
      entryTime: 0,
      maeAbs: 0,
      mfeAbs: 0
    };
    const context = buildEvaluationContext(position, 90, 9, [], 10_000, DAY);

    expect(context).toMatchObject({
      position_dir: -1,
      entry_price: 100,
      unrealized_pnl: 20,
      unrealized_pnl_pct: 10,
      bars_in_position: 5
    });
  });
});

describe("bounded variable trace", () => {
  it("caps points, snapshots variables and always retains the final bar", () => {
    const trace = createVariableTraceCollector(1000, 10);
    const variables = new Map<string, number>();
    for (let index = 0; index < 1000; index += 1) {
      variables.set("count", index);
      trace.capture(index, index, variables);
    }

    const points = trace.result() ?? [];
    expect(points).toHaveLength(10);
    expect(points[0]).toEqual({ time: 0, vars: { count: 0 } });
    expect(points.at(-1)).toEqual({ time: 999, vars: { count: 999 } });
  });

  it("omits traces for strategies without mutable variables", () => {
    const trace = createVariableTraceCollector(10);
    trace.capture(9, 9, new Map());
    expect(trace.result()).toBeUndefined();
  });
});
