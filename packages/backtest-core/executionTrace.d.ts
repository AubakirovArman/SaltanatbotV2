import type { BacktestDataProvenance } from "./provenance.js";
import type { Trade } from "./types.js";
export declare const BACKTEST_EXECUTION_TRACE_VERSION: 1;
interface BarEvent {
    barIndex: number;
    barTime: number;
}
export type BacktestExecutionEvent = (BarEvent & {
    kind: "fill_scheduled";
    action: "entry" | "exit";
    direction: "long" | "short" | null;
}) | (BarEvent & {
    kind: "fill_dropped";
    action: "entry" | "exit";
    reason: "end_of_data";
}) | (BarEvent & {
    kind: "entry_rejected";
    direction: "long" | "short";
    reason: "short_disabled" | "invalid_size";
}) | (BarEvent & {
    kind: "position_opened";
    direction: "long" | "short";
    price: number | null;
    qty: number | null;
    equity: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
}) | (BarEvent & {
    kind: "position_closed";
    direction: "long" | "short";
    price: number | null;
    qty: number | null;
    reason: Trade["reason"];
    pnl: number | null;
    equityBefore: number | null;
    equityAfter: number | null;
}) | (BarEvent & {
    kind: "funding_charged";
    amount: number | null;
    equityAfter: number | null;
}) | (BarEvent & {
    kind: "warning";
    code: "execution_budget_exceeded" | "position_size_adjusted" | "liquidated";
}) | {
    kind: "provenance";
    provenance: BacktestDataProvenance;
};
export interface BacktestExecutionTrace {
    v: typeof BACKTEST_EXECUTION_TRACE_VERSION;
    events: BacktestExecutionEvent[];
}
/** Finalize a JSON-safe deterministic trace and append the report provenance snapshot. */
export declare function buildBacktestExecutionTrace(events: BacktestExecutionEvent[], provenance: BacktestDataProvenance): BacktestExecutionTrace;
export {};
