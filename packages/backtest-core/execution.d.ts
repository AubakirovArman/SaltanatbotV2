import type { Candle } from "@saltanatbotv2/contracts";
import { type SecurityDataContext, type StrategyIR } from "@saltanatbotv2/strategy-core";
import type { BacktestConfig, BacktestResult, BacktestRunContext } from "./types.js";
export declare const DEFAULT_CONFIG: BacktestConfig;
export declare function runBacktest(ir: StrategyIR, candles: Candle[], config?: BacktestConfig, securityData?: SecurityDataContext | undefined, context?: BacktestRunContext | undefined): BacktestResult;
