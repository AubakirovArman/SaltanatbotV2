export const STRATEGY_TRACE_VERSION = 1;
const finite = (value) => Number.isFinite(value) ? value : null;
/** Normalize evaluator intents into a stable JSON-safe semantic event order. */
export function traceBarIntents(intents, barIndex, barTime) {
    const events = [];
    if (intents.entry)
        events.push({ kind: "entry", direction: intents.entry });
    if (intents.exit)
        events.push({ kind: "exit" });
    if (intents.stop)
        events.push({ kind: "stop", mode: intents.stop.mode, value: finite(intents.stop.value) });
    if (intents.target)
        events.push({ kind: "target", mode: intents.target.mode, value: finite(intents.target.value) });
    if (intents.trail)
        events.push({ kind: "trail", mode: intents.trail.mode, value: finite(intents.trail.value) });
    if (intents.size)
        events.push({ kind: "size", mode: intents.size.mode, value: finite(intents.size.value) });
    for (const alert of intents.alerts)
        events.push({ kind: "alert", message: alert.message });
    for (const marker of intents.markers) {
        events.push({ kind: "marker", direction: marker.dir, label: marker.label });
    }
    if (intents.budgetExceeded)
        events.push({ kind: "budget_exceeded" });
    return { v: STRATEGY_TRACE_VERSION, barIndex, barTime, events };
}
