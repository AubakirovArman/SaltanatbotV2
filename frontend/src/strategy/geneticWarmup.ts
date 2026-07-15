import type { Candle } from "../types";
import { estimateWarmupBars } from "./backtest/warmup";
import type { StrategyIR } from "./ir";

export function assertGeneticWindowWarmup(ir: StrategyIR, windows: ReadonlyArray<readonly [string, readonly Candle[]]>): number {
  const requiredWarmupBars = estimateWarmupBars(ir);
  for (const [name, window] of windows) {
    if (window.length <= requiredWarmupBars) {
      throw new Error(`Genetic ${name} window has ${window.length} bars but this genome requires ${requiredWarmupBars} warm-up bars; increase history or reduce indicator lookbacks`);
    }
  }
  return requiredWarmupBars;
}
