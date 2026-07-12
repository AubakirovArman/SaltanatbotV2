import { describe, expect, it } from "vitest";
import {
  analyzePortfolioRisk,
  blockBootstrapRisk,
  stressPortfolio,
  type PortfolioEquityPoint,
  type PortfolioTrade
} from "@saltanatbotv2/backtest-core";

describe("portfolio risk analysis", () => {
  it("calculates historical tail loss and allocation concentration", () => {
    const result = analyzePortfolioRisk(
      curve([10_000, 11_000, 9_900, 10_395, 9_355.5]),
      [trade("BTCUSDT", 6_000), trade("ETHUSDT", 2_000)],
      10_000,
      { runs: 200, blockSize: 2 }
    );

    expect(result.historical).toMatchObject({
      observations: 4,
      lossProbabilityPct: 50,
      valueAtRisk95Pct: 10,
      expectedShortfall95Pct: 10,
      valueAtRisk99Pct: 10,
      expectedShortfall99Pct: 10,
      worstPeriodPct: 10
    });
    expect(result.concentration).toMatchObject({
      largestSymbol: "BTCUSDT",
      largestAllocationPct: 75,
      effectiveSymbols: 1.6,
      herfindahlIndex: 0.625
    });
    expect(result.concentration.allocations.map(({ symbol, sharePct }) => ({ symbol, sharePct }))).toEqual([
      { symbol: "BTCUSDT", sharePct: 75 },
      { symbol: "ETHUSDT", sharePct: 25 }
    ]);
  });

  it("uses a byte-stable moving-block bootstrap with ordered percentiles", () => {
    const returns = [0.02, -0.01, 0.03, -0.04, 0.01, 0.02, -0.015, 0.005];
    const first = blockBootstrapRisk(returns, 10_000, { runs: 500, blockSize: 3 });
    const second = blockBootstrapRisk(returns, 10_000, { runs: 500, blockSize: 3 });
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(first.method).toBe("moving_block_bootstrap");
    expect(first.netProfit.p5).toBeLessThanOrEqual(first.netProfit.p50);
    expect(first.netProfit.p50).toBeLessThanOrEqual(first.netProfit.p95);
    expect(first.maxDrawdownPct.p5).toBeLessThanOrEqual(first.maxDrawdownPct.p95);
    expect(first.riskOfRuinPct).toBe(0);
  });

  it("bounds work for large histories by compounding adjacent observations", () => {
    const result = blockBootstrapRisk(Array.from({ length: 10_000 }, (_, index) => index % 2 ? -0.001 : 0.001), 10_000, {
      runs: 100,
      maxObservations: 128
    });
    expect(result?.sourceObservations).toBe(10_000);
    expect(result?.observations).toBeLessThanOrEqual(128);
    expect(result?.runs).toBe(100);
  });

  it("returns no simulation for an unusable return series", () => {
    expect(blockBootstrapRisk([], 10_000)).toBeNull();
    expect(blockBootstrapRisk([0.1], 10_000)).toBeNull();
    expect(blockBootstrapRisk([0.1, Number.NaN], 10_000)).toBeNull();
    expect(blockBootstrapRisk([0.1, 0.2], 0)).toBeNull();
  });

  it("reports ruin when a sampled shared-equity period loses all capital", () => {
    expect(blockBootstrapRisk([-1, 0.1], 10_000, { runs: 100, blockSize: 2 })?.riskOfRuinPct).toBe(100);
  });

  it("replays transparent execution, exit and funding shocks over baseline equity", () => {
    const stressedTrade = { ...trade("BTCUSDT", 1_000), qty: 10, entryPrice: 100, exitPrice: 110, fundingPaid: 10 };
    const analysis = stressPortfolio(curve([10_000, 11_000, 10_500]), [stressedTrade], 10_000, [{
      id: "custom",
      extraFillCostBps: 10,
      adverseExitBps: 20,
      fundingMultiplier: 2
    }]);

    expect(analysis.turnover).toBe(2_100);
    expect(analysis.breakEvenExtraFillCostBps).toBeCloseTo(2_380.95238, 5);
    expect(analysis.scenarios[0]).toMatchObject({ profitable: true });
    expect(analysis.scenarios[0].extraCost).toBeCloseTo(14.3, 8);
    expect(analysis.scenarios[0].netProfit).toBeCloseTo(485.7, 8);
    expect(analysis.scenarios[0].finalEquity).toBeCloseTo(10_485.7, 8);
    expect(analysis.scenarios[0].deltaFromBaseline).toBeCloseTo(-14.3, 8);
    expect(analysis.scenarios[0].maxDrawdown).toBeCloseTo(500, 8);
  });

  it("publishes four bounded default scenarios and clamps unsafe custom inputs", () => {
    const base = stressPortfolio(curve([10_000, 10_100]), [trade("BTCUSDT", 1_000)], 10_000);
    expect(base.scenarios.map((scenario) => scenario.id)).toEqual(["execution_cost", "adverse_exit", "funding_double", "combined"]);

    const custom = stressPortfolio(curve([10_000, 10_100]), [trade("BTCUSDT", 1_000)], 10_000, [{
      id: "custom",
      extraFillCostBps: -10,
      adverseExitBps: Number.POSITIVE_INFINITY,
      fundingMultiplier: 1_000
    }]).scenarios[0];
    expect(custom).toMatchObject({ extraFillCostBps: 0, adverseExitBps: 0, fundingMultiplier: 100 });
  });
});

function curve(equities: number[]): PortfolioEquityPoint[] {
  return equities.map((equity, index) => ({ time: index * 60_000, equity, grossExposure: 0, grossExposurePct: 0, openPositions: 0 }));
}

function trade(symbol: string, allocatedNotional: number): PortfolioTrade {
  return {
    symbol,
    direction: "long",
    entryIndex: 0,
    exitIndex: 1,
    entryTime: 0,
    exitTime: 60_000,
    entryPrice: 100,
    exitPrice: 101,
    qty: 1,
    pnl: 1,
    pnlPct: 1,
    reason: "signal",
    barsHeld: 1,
    maePct: 0,
    mfePct: 1,
    requestedNotional: allocatedNotional,
    allocatedNotional,
    allocationPct: 50,
    scale: 1,
    fundingPaid: 0
  };
}
