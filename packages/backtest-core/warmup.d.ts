import type { StrategyIR } from "@saltanatbotv2/strategy-core";
export declare const DYNAMIC_WARMUP_BARS = 200;
/** Estimate the history excluded from metrics while indicators warm up. */
export declare function estimateWarmupBars(ir: StrategyIR): number;
