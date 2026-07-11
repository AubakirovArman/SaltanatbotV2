export const BACKTEST_EXECUTION_TRACE_VERSION = 1;
/** Finalize a JSON-safe deterministic trace and append the report provenance snapshot. */
export function buildBacktestExecutionTrace(events, provenance) {
    const trace = { v: BACKTEST_EXECUTION_TRACE_VERSION, events: [...events, { kind: "provenance", provenance }] };
    return JSON.parse(JSON.stringify(trace, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? null : value));
}
