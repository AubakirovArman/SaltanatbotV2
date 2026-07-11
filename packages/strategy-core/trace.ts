import type { BarIntents } from "./evaluator.js";

export const STRATEGY_TRACE_VERSION = 2 as const;

export type StrategyTraceEvent =
  | { kind: "entry"; direction: "long" | "short" }
  | { kind: "exit" }
  | { kind: "stop" | "target"; mode: "price" | "percent" | "atr"; value: number | null }
  | { kind: "trail"; mode: "percent" | "atr"; value: number | null }
  | { kind: "size"; mode: "units" | "equity_pct" | "risk_pct"; value: number | null }
  | { kind: "alert"; message: string }
  | { kind: "marker"; direction: "up" | "down"; label: string }
  | { kind: "budget_exceeded" };

export interface StrategyExpressionExplanation {
  path: string;
  role: "condition" | "value" | "loop_bound";
  expressionKind: string;
  result: number | boolean | null;
  evaluations: number;
  trueCount?: number;
}

export interface StrategyVariableChange {
  name: string;
  before: number | null;
  after: number | null;
}

export interface StrategyTraceDiagnostics {
  explanations?: StrategyExpressionExplanation[];
  variableChanges?: StrategyVariableChange[];
  explanationsTruncated?: boolean;
  variableChangesTruncated?: boolean;
}

export interface StrategyBarTrace {
  v: typeof STRATEGY_TRACE_VERSION;
  barIndex: number;
  barTime: number;
  events: StrategyTraceEvent[];
  explanations: StrategyExpressionExplanation[];
  variableChanges: StrategyVariableChange[];
  explanationsTruncated: boolean;
  variableChangesTruncated: boolean;
}

const finite = (value: number): number | null => Number.isFinite(value) ? value : null;

/** Normalize evaluator intents into a stable JSON-safe semantic event order. */
export function traceBarIntents(
  intents: BarIntents,
  barIndex: number,
  barTime: number,
  diagnostics: StrategyTraceDiagnostics = {}
): StrategyBarTrace {
  const events: StrategyTraceEvent[] = [];
  if (intents.entry) events.push({ kind: "entry", direction: intents.entry });
  if (intents.exit) events.push({ kind: "exit" });
  if (intents.stop) events.push({ kind: "stop", mode: intents.stop.mode, value: finite(intents.stop.value) });
  if (intents.target) events.push({ kind: "target", mode: intents.target.mode, value: finite(intents.target.value) });
  if (intents.trail) events.push({ kind: "trail", mode: intents.trail.mode, value: finite(intents.trail.value) });
  if (intents.size) events.push({ kind: "size", mode: intents.size.mode, value: finite(intents.size.value) });
  for (const alert of intents.alerts) events.push({ kind: "alert", message: alert.message });
  for (const marker of intents.markers) {
    events.push({ kind: "marker", direction: marker.dir, label: marker.label });
  }
  if (intents.budgetExceeded) events.push({ kind: "budget_exceeded" });
  return {
    v: STRATEGY_TRACE_VERSION,
    barIndex,
    barTime,
    events,
    explanations: diagnostics.explanations ?? [],
    variableChanges: diagnostics.variableChanges ?? [],
    explanationsTruncated: diagnostics.explanationsTruncated ?? false,
    variableChangesTruncated: diagnostics.variableChangesTruncated ?? false
  };
}
