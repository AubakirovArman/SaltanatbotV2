import type { BarIntents } from "./evaluator.js";
export declare const STRATEGY_TRACE_VERSION: 1;
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
export interface StrategyBarTrace {
    v: typeof STRATEGY_TRACE_VERSION;
    barIndex: number;
    barTime: number;
    events: StrategyTraceEvent[];
}
/** Normalize evaluator intents into a stable JSON-safe semantic event order. */
export declare function traceBarIntents(intents: BarIntents, barIndex: number, barTime: number): StrategyBarTrace;
