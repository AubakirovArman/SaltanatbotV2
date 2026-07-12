import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PORTFOLIO_BACKTEST_CONFIG } from "@saltanatbotv2/backtest-core";
import { DEFAULT_CONFIG } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import { runPortfolioResearch, uniqueSymbols } from "../src/strategy/portfolioResearch";
import type { Candle } from "../src/types";

const strategy: StrategyIR = {
  name: "Portfolio threshold",
  inputs: [],
  body: [
    { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } },
    { k: "exit", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } },
    { k: "size", mode: "units", value: { k: "num", v: 10 } }
  ]
};

describe("portfolio research orchestration", () => {
  it("loads every unique market and creates a shared-capital report", async () => {
    const loadHistory = vi.fn(async ({ symbol }: { symbol: string }) => candles(symbol === "BTCUSDT" ? 110 : 120));
    const result = await runPortfolioResearch({
      ir: strategy,
      symbols: ["btcusdt", "ETHUSDT", "BTCUSDT"],
      timeframe: "1h",
      bars: 40,
      exchange: "binance",
      backtestConfig: { ...DEFAULT_CONFIG, commissionPct: 0, slippagePct: 0 },
      portfolioConfig: { ...DEFAULT_PORTFOLIO_BACKTEST_CONFIG, maxConcurrentPositions: 2, maxPositionExposurePct: 50 }
    }, { loadHistory: loadHistory as never, loadSecurity: vi.fn(async () => ({})) });

    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "saltanat-portfolio-backtest", symbols: ["BTCUSDT", "ETHUSDT"] });
    expect(result.commonRange.points).toBe(40);
    expect(result.metrics.totalCandidates).toBeGreaterThan(0);
  });

  it("rejects fewer than two markets before requesting history", async () => {
    await expect(runPortfolioResearch({
      ir: strategy,
      symbols: ["BTCUSDT", "btcusdt"],
      timeframe: "1h",
      bars: 40,
      exchange: "binance",
      backtestConfig: DEFAULT_CONFIG,
      portfolioConfig: { ...DEFAULT_PORTFOLIO_BACKTEST_CONFIG }
    })).rejects.toThrow("at least two");
    expect(uniqueSymbols([" btcusdt ", "BTCUSDT", " ethusdt "])).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});

function candles(high: number): Candle[] {
  return Array.from({ length: 40 }, (_, index) => {
    const close = index < 20 ? high : 90;
    return { time: index * 3_600_000, open: close, high: close + 1, low: close - 1, close, volume: 1_000 };
  });
}
