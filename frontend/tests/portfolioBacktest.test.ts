import { describe, expect, it } from "vitest";
import {
  simulatePortfolioBacktest,
  sanitizePortfolioBacktestConfig,
  type BacktestResult,
  type PortfolioBacktestLeg,
  type Trade
} from "@saltanatbotv2/backtest-core";
import type { Candle } from "../src/types";

const HOUR = 3_600_000;

describe("multi-symbol portfolio backtest", () => {
  it("uses one deterministic capital pool and rejects simultaneous overflow", () => {
    const result = simulatePortfolioBacktest([
      leg("BTCUSDT", [100, 105, 110], [trade(0, 2, 100, 110, 100, 1_000)]),
      leg("ETHUSDT", [100, 110, 120], [trade(0, 2, 100, 120, 100, 2_000)])
    ], { initialCapital: 10_000, maxConcurrentPositions: 1, maxGrossExposurePct: 200, maxPositionExposurePct: 100 });

    expect(result.trades).toMatchObject([{ symbol: "BTCUSDT", allocatedNotional: 10_000, pnl: 1_000 }]);
    expect(result.rejectedEntries).toMatchObject([{ symbol: "ETHUSDT", reason: "max_concurrent" }]);
    expect(result.metrics).toMatchObject({ finalEquity: 11_000, acceptedTrades: 1, rejectedTrades: 1, maxConcurrentPositions: 1 });
  });

  it("partially allocates remaining gross capacity and preserves scaled outcomes", () => {
    const result = simulatePortfolioBacktest([
      leg("BTCUSDT", [100, 105, 110], [trade(0, 2, 100, 110, 100, 1_000)]),
      leg("ETHUSDT", [100, 110, 120], [trade(0, 2, 100, 120, 100, 2_000)])
    ], { initialCapital: 10_000, maxConcurrentPositions: 2, maxGrossExposurePct: 100, maxPositionExposurePct: 60, minAllocationPct: 25 });

    expect(result.trades.map(({ symbol, allocatedNotional, scale, pnl }) => ({ symbol, allocatedNotional, scale, pnl }))).toEqual([
      { symbol: "BTCUSDT", allocatedNotional: 6_000, scale: 0.6, pnl: 600 },
      { symbol: "ETHUSDT", allocatedNotional: 4_000, scale: 0.4, pnl: 800 }
    ]);
    expect(result.metrics.finalEquity).toBe(11_400);
    expect(result.metrics.peakGrossExposurePct).toBeCloseTo(100, 8);
  });

  it("rejects immaterial partial fills and accounts for accepted funding chronologically", () => {
    const rejection = simulatePortfolioBacktest([
      leg("BTCUSDT", [100, 100, 110], [trade(0, 2, 100, 110, 100, 1_000)]),
      leg("ETHUSDT", [100, 100, 120], [trade(0, 2, 100, 120, 100, 2_000)])
    ], { maxConcurrentPositions: 2, maxGrossExposurePct: 70, maxPositionExposurePct: 60, minAllocationPct: 25 });
    expect(rejection.rejectedEntries).toMatchObject([{ symbol: "ETHUSDT", reason: "allocation_too_small", availableNotional: 1_000 }]);

    const funded = simulatePortfolioBacktest([
      leg("BTCUSDT", [100, 105, 110], [trade(0, 2, 100, 110, 100, 1_000)], [{ kind: "funding_charged", barIndex: 1, barTime: HOUR, amount: 100, equityAfter: 9_900 }]),
      leg("ETHUSDT", [100, 100, 100], [])
    ], { maxPositionExposurePct: 50, maxGrossExposurePct: 100 });
    expect(funded.trades[0]).toMatchObject({ fundingPaid: 50, pnl: 500 });
    expect(funded.metrics).toMatchObject({ fundingPaid: 50, finalEquity: 10_450 });
  });

  it("measures only common history and emits pairwise return correlation", () => {
    const btc = leg("BTCUSDT", [100, 110, 99], []);
    const eth = leg("ETHUSDT", [100, 90, 99], []);
    const result = simulatePortfolioBacktest([btc, eth]);
    expect(result.commonRange).toEqual({ fromTime: 0, toTime: 2 * HOUR, points: 3 });
    expect(result.correlation.values).toEqual([[1, -1], [-1, 1]]);
    expect(result.correlation.averagePairwise).toBe(-1);
  });

  it("clamps every persisted risk limit", () => {
    expect(sanitizePortfolioBacktestConfig({ initialCapital: -1, maxConcurrentPositions: 99, maxGrossExposurePct: Infinity, maxPositionExposurePct: 0, minAllocationPct: 120 })).toEqual({
      initialCapital: 100,
      maxConcurrentPositions: 20,
      maxGrossExposurePct: 100,
      maxPositionExposurePct: 1,
      minAllocationPct: 100
    });
  });
});

function leg(symbol: string, closes: number[], trades: Trade[], events: Array<Record<string, unknown>> = []): PortfolioBacktestLeg {
  const candles: Candle[] = closes.map((close, index) => ({ time: index * HOUR, open: close, high: close, low: close, close, volume: 100 }));
  const report = {
    name: "Shared strategy",
    trades,
    metadata: { config: { initialCapital: 10_000, commissionPct: 0 } },
    executionTrace: { v: 1, events }
  } as unknown as BacktestResult;
  return { symbol, candles, report };
}

function trade(entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, qty: number, pnl: number): Trade {
  return {
    direction: "long",
    entryIndex,
    exitIndex,
    entryTime: entryIndex * HOUR,
    exitTime: exitIndex * HOUR,
    entryPrice,
    exitPrice,
    qty,
    pnl,
    pnlPct: pnl / (entryPrice * qty) * 100,
    reason: "signal",
    barsHeld: exitIndex - entryIndex,
    maePct: 0,
    mfePct: Math.max(0, (exitPrice - entryPrice) / entryPrice * 100)
  };
}
