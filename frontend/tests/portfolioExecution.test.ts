import { describe, expect, it } from "vitest";
import { analyzePortfolioExecution, type PortfolioTrade } from "@saltanatbotv2/backtest-core";

describe("portfolio execution analysis", () => {
  it("reconciles configured commission, adverse fill slippage and funding", () => {
    const result = analyzePortfolioExecution([
      trade({
        symbol: "BTCUSDT",
        entryPrice: 101,
        exitPrice: 108.9,
        qty: 10,
        pnl: 76.901,
        fundingPaid: 5,
        reason: "signal"
      })
    ], [{ symbol: "BTCUSDT", commissionPct: 0.1, slippagePct: 1 }]);

    expect(result.method).toBe("configured_fill_attribution");
    expect(result.totals).toMatchObject({ trades: 1, turnover: 2_099, netPnl: 71.901 });
    expect(result.totals.commissionPaid).toBeCloseTo(2.099, 8);
    expect(result.totals.estimatedSlippageCost).toBeCloseTo(21, 8);
    expect(result.totals.fundingPaid).toBe(5);
    expect(result.totals.totalCost).toBeCloseTo(28.099, 8);
    expect(result.totals.referenceGrossPnl).toBeCloseTo(100, 8);
    expect(result.totals.costDragPct).toBeCloseTo(28.099, 8);
    expect(result.totals.allInCostBps).toBeCloseTo(133.8685, 4);
  });

  it("does not invent exit slippage for target or liquidation fills", () => {
    const result = analyzePortfolioExecution([
      trade({ symbol: "BTCUSDT", entryPrice: 101, exitPrice: 110, qty: 10, pnl: 90, reason: "target" }),
      trade({ symbol: "ETHUSDT", entryPrice: 198, exitPrice: 180, qty: 5, pnl: 90, direction: "short", reason: "liquidation" })
    ], [
      { symbol: "BTCUSDT", commissionPct: 0, slippagePct: 1 },
      { symbol: "ETHUSDT", commissionPct: 0, slippagePct: 1 }
    ]);

    expect(result.byMarket.find((row) => row.symbol === "BTCUSDT")?.estimatedSlippageCost).toBeCloseTo(10, 8);
    expect(result.byMarket.find((row) => row.symbol === "ETHUSDT")?.estimatedSlippageCost).toBeCloseTo(10, 8);
    expect(result.byExitReason.map((row) => row.reason)).toEqual(["target", "liquidation"]);
  });

  it("keeps empty configured markets and sanitizes unsafe assumptions", () => {
    const result = analyzePortfolioExecution([], [
      { symbol: " BTCUSDT ", commissionPct: Number.NaN, slippagePct: -5 },
      { symbol: "BTCUSDT", commissionPct: 5, slippagePct: 5 },
      { symbol: "ETHUSDT", commissionPct: 200, slippagePct: 200 }
    ]);

    expect(result.totals).toMatchObject({ trades: 0, turnover: 0, totalCost: 0, allInCostBps: 0, costDragPct: null });
    expect(result.byMarket).toMatchObject([
      { symbol: "BTCUSDT", commissionPct: 0, slippagePct: 0, trades: 0 },
      { symbol: "ETHUSDT", commissionPct: 100, slippagePct: 99.999999, trades: 0 }
    ]);
  });
});

function trade(overrides: Partial<PortfolioTrade> = {}): PortfolioTrade {
  return {
    symbol: "BTCUSDT",
    direction: "long",
    entryIndex: 0,
    exitIndex: 1,
    entryTime: 0,
    exitTime: 60_000,
    entryPrice: 100,
    exitPrice: 110,
    qty: 1,
    pnl: 10,
    pnlPct: 10,
    reason: "signal",
    barsHeld: 1,
    maePct: 0,
    mfePct: 10,
    requestedNotional: 100,
    allocatedNotional: 100,
    allocationPct: 1,
    scale: 1,
    fundingPaid: 0,
    ...overrides
  };
}
