import type { Position } from "./broker.js";
import type { Trade } from "./types.js";
export interface VariableTracePoint {
    time: number;
    vars: Record<string, number>;
}
export interface VariableTraceCollector {
    capture(index: number, time: number, variables: Map<string, number>): void;
    result(): VariableTracePoint[] | undefined;
}
/** Build the position, PnL and daily-stat context consumed by StrategyIR `ctx` nodes. */
export declare function buildEvaluationContext(position: Position | null, price: number, index: number, trades: Trade[], equity: number, barTime: number): Record<string, number>;
/** Keep a deterministic bounded trace while always retaining the final bar. */
export declare function createVariableTraceCollector(totalBars: number, maxPoints?: number): VariableTraceCollector;
