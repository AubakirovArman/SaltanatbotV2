import type { StrategyExpressionExplanation, StrategyTraceEvent, StrategyVariableChange } from "@saltanatbotv2/strategy-core";
import type { BacktestExecutionEvent } from "./executionTrace.js";
import type { BacktestResult, EquityPoint, Trade, TradeMarker } from "./types.js";

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
export function createBacktestReplay(result: BacktestResult): BacktestReplayTimeline {
  const executionByBar = new Map<number, BacktestExecutionEvent[]>();
  for (const event of result.executionTrace.events) {
    if (!("barIndex" in event)) continue;
    const bucket = executionByBar.get(event.barIndex) ?? [];
    bucket.push(event);
    executionByBar.set(event.barIndex, bucket);
  }
  const equityByTime = new Map(result.equityCurve.map((point) => [point.time, point] as const));
  const frames = result.eventTrace.map((trace, cursor) => ({
    cursor,
    total: result.eventTrace.length,
    barIndex: trace.barIndex,
    barTime: trace.barTime,
    equity: equityAt(equityByTime, result.equityCurve, trace.barTime),
    strategyEvents: Object.freeze([...trace.events]),
    executionEvents: Object.freeze([...(executionByBar.get(trace.barIndex) ?? [])]),
    explanations: Object.freeze([...trace.explanations]),
    variableChanges: Object.freeze([...trace.variableChanges]),
    signals: Object.freeze(result.signals.filter((signal) => signal.time === trace.barTime)),
    tradesOpened: Object.freeze(result.trades.filter((trade) => trade.entryIndex === trace.barIndex)),
    tradesClosed: Object.freeze(result.trades.filter((trade) => trade.exitIndex === trace.barIndex))
  } satisfies BacktestReplayFrame));
  return Object.freeze({ schemaVersion: 1 as const, frames: Object.freeze(frames) });
}

export function replayFrame(timeline: BacktestReplayTimeline, cursor: number): BacktestReplayFrame | undefined {
  if (!timeline.frames.length) return undefined;
  return timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.floor(cursor)))] ?? timeline.frames[0];
}

export function stepReplay(timeline: BacktestReplayTimeline, cursor: number, delta: number): BacktestReplayFrame | undefined {
  return replayFrame(timeline, cursor + delta);
}

function equityAt(byTime: ReadonlyMap<number, EquityPoint>, points: readonly EquityPoint[], time: number): number | undefined {
  const exact = byTime.get(time);
  if (exact) return exact.equity;
  let found: number | undefined;
  for (const point of points) {
    if (point.time > time) break;
    found = point.equity;
  }
  return found;
}
