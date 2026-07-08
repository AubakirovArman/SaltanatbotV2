import { describe, expect, it } from "vitest";
import type { Trade } from "../src/strategy/backtest";
import { monteCarlo } from "../src/strategy/montecarlo";

/**
 * Monte Carlo determinism: the PRNG is a seeded mulberry32 keyed off the trade
 * count, so the same trades must always yield identical percentiles. Math.random
 * is never used, so two runs are byte-identical.
 */

// Minimal Trade objects — monteCarlo only reads `.pnl`.
function trade(pnl: number): Trade {
  return {
    direction: "long",
    entryIndex: 0,
    exitIndex: 1,
    entryTime: 0,
    exitTime: 1,
    entryPrice: 100,
    exitPrice: 100 + pnl,
    qty: 1,
    pnl,
    pnlPct: pnl,
    reason: "signal",
    barsHeld: 1,
    maePct: 0,
    mfePct: 0,
  };
}

const trades: Trade[] = [120, -80, 50, -40, 200, -150, 75, -30, 90, -60].map(trade);
const config = { initialCapital: 10_000 };

describe("monteCarlo determinism", () => {
  it("returns identical percentiles for the same trades + run count", () => {
    const a = monteCarlo(trades, config, 500);
    const b = monteCarlo(trades, config, 500);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a?.netProfit).toEqual(b?.netProfit);
    expect(a?.maxDrawdownPct).toEqual(b?.maxDrawdownPct);
    expect(a?.riskOfRuin).toEqual(b?.riskOfRuin);
    expect(a?.bands).toEqual(b?.bands);
  });

  it("is stable across separate module-level invocations (no shared RNG state)", () => {
    const first = monteCarlo(trades, config, 300);
    // Interleave an unrelated MC run to prove there's no leaked global RNG state.
    monteCarlo([trade(1), trade(-1), trade(2)], config, 999);
    const second = monteCarlo(trades, config, 300);
    expect(first).toEqual(second);
  });

  it("reports a coherent percentile ordering (p5 <= p50 <= p95)", () => {
    const stats = monteCarlo(trades, config, 500);
    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.netProfit.p5).toBeLessThanOrEqual(stats.netProfit.p50);
    expect(stats.netProfit.p50).toBeLessThanOrEqual(stats.netProfit.p95);
    expect(stats.maxDrawdownPct.p5).toBeLessThanOrEqual(stats.maxDrawdownPct.p95);
    expect(stats.tradesPerRun).toBe(trades.length);
    expect(stats.runs).toBe(500);
  });

  it("returns null when there are fewer than 2 trades", () => {
    expect(monteCarlo([trade(10)], config, 100)).toBeNull();
    expect(monteCarlo([], config, 100)).toBeNull();
  });

  it("computes the same seed-derived result regardless of run ordering of two datasets", () => {
    // Two different trade-count datasets get different seeds, but each is stable.
    const setA = monteCarlo(trades, config, 200);
    const setB = monteCarlo(trades.slice(0, 6), config, 200);
    expect(monteCarlo(trades, config, 200)).toEqual(setA);
    expect(monteCarlo(trades.slice(0, 6), config, 200)).toEqual(setB);
  });
});
