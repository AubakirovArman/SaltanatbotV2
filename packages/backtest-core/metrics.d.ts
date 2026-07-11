import type { Candle } from "@saltanatbotv2/contracts";
import type { BacktestConfig, BacktestMetrics, EquityPoint, Trade } from "./types.js";
export declare function computeBacktestMetrics(trades: Trade[], equityCurve: EquityPoint[], config: BacktestConfig, barsInMarket: number, measuredBars: number, candles: Candle[], liquidated: boolean, fundingPaid?: number): BacktestMetrics;
export declare function medianDelta(candles: Candle[]): number;
