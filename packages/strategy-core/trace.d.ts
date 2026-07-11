import type { BarIntents } from "./evaluator.js";
export declare const STRATEGY_TRACE_VERSION: 2;
export type StrategyTraceEvent = {
    kind: "entry";
    direction: "long" | "short";
} | {
    kind: "exit";
} | {
    kind: "stop" | "target";
    mode: "price" | "percent" | "atr";
    value: number | null;
} | {
    kind: "trail";
    mode: "percent" | "atr";
    value: number | null;
} | {
    kind: "size";
    mode: "units" | "equity_pct" | "risk_pct";
    value: number | null;
} | {
    kind: "alert";
    message: string;
} | {
    kind: "marker";
    direction: "up" | "down";
    label: string;
} | {
    kind: "budget_exceeded";
};
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
/** Normalize evaluator intents into a stable JSON-safe semantic event order. */
export declare function traceBarIntents(intents: BarIntents, barIndex: number, barTime: number, diagnostics?: StrategyTraceDiagnostics): StrategyBarTrace;
