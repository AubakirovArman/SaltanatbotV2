import type { Candle } from "@saltanatbotv2/contracts";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import { type BacktestConfig, type Trade } from "./types.js";
export interface BacktestBenchmarkExpectedTrade {
    entryIndex: number;
    exitIndex: number;
    entryPrice: number;
    exitPrice: number;
    direction: Trade["direction"];
    reason: Trade["reason"];
    pnl: number;
}
export interface BacktestBenchmark {
    id: string;
    description: string;
    strategy: StrategyIR;
    candles: Candle[];
    config: Required<BacktestConfig>;
    expectedTrades: BacktestBenchmarkExpectedTrade[];
}
/** Reviewed deterministic broker references; changes require explicit expected-trade review. */
export declare const BACKTEST_BENCHMARKS: readonly BacktestBenchmark[];
