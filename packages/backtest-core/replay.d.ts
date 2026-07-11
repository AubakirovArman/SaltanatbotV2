import type { StrategyExpressionExplanation, StrategyTraceEvent, StrategyVariableChange } from "@saltanatbotv2/strategy-core";
import type { BacktestExecutionEvent } from "./executionTrace.js";
import type { BacktestResult, Trade, TradeMarker } from "./types.js";
export interface BacktestReplayFrame {
    cursor: number;
    total: number;
    barIndex: number;
    barTime: number;
    equity?: number;
    strategyEvents: readonly StrategyTraceEvent[];
    executionEvents: readonly BacktestExecutionEvent[];
    explanations: readonly StrategyExpressionExplanation[];
    variableChanges: readonly StrategyVariableChange[];
    signals: readonly TradeMarker[];
    tradesOpened: readonly Trade[];
    tradesClosed: readonly Trade[];
}
export interface BacktestReplayTimeline {
    schemaVersion: 1;
    frames: readonly BacktestReplayFrame[];
}
/** Build a byte-deterministic, random-access replay from an immutable report. */
export declare function createBacktestReplay(result: BacktestResult): BacktestReplayTimeline;
export declare function replayFrame(timeline: BacktestReplayTimeline, cursor: number): BacktestReplayFrame | undefined;
export declare function stepReplay(timeline: BacktestReplayTimeline, cursor: number, delta: number): BacktestReplayFrame | undefined;
