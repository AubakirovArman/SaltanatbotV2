import { BACKTEST_BENCHMARKS } from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/strategy/backtest";

describe("public backtest execution benchmarks", () => {
  it.each(BACKTEST_BENCHMARKS)("matches reviewed trades for $id", (benchmark) => {
    const first = runBacktest(benchmark.strategy, benchmark.candles, benchmark.config);
    const second = runBacktest(benchmark.strategy, benchmark.candles, benchmark.config);
    const actual = first.trades.map((trade) => ({
      entryIndex: trade.entryIndex,
      exitIndex: trade.exitIndex,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      direction: trade.direction,
      reason: trade.reason,
      pnl: trade.pnl
    }));

    expect(actual).toEqual(benchmark.expectedTrades);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps benchmark identities and expected outcomes unique", () => {
    expect(new Set(BACKTEST_BENCHMARKS.map((item) => item.id)).size).toBe(BACKTEST_BENCHMARKS.length);
    expect(BACKTEST_BENCHMARKS.every((item) => item.expectedTrades.length > 0)).toBe(true);
  });
});
