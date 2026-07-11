import { computeBacktestMetrics } from "./metrics.js";
import { buildBacktestDataProvenance } from "./provenance.js";
/** Assemble the canonical immutable report after the execution loop completes. */
export function assembleBacktestReport(input) {
    const warmupBars = Math.max(0, Math.min(input.equityCurve.length, Math.floor(input.warmupBars)));
    const measured = input.equityCurve.slice(warmupBars);
    const tested = {
        fromTime: measured[0]?.time ?? input.candles[0]?.time ?? 0,
        toTime: measured.at(-1)?.time ?? input.candles.at(-1)?.time ?? 0,
        bars: measured.length,
        warmupBars
    };
    return {
        name: input.name,
        trades: input.trades,
        equityCurve: input.equityCurve,
        markers: input.markers,
        signals: input.signals,
        alerts: input.alerts,
        warnings: input.warnings,
        metrics: computeBacktestMetrics(input.trades, measured, input.config, input.barsInMarket, measured.length, input.candles, input.liquidated, input.fundingPaid),
        tested,
        varTrace: input.varTrace,
        eventTrace: input.eventTrace,
        provenance: buildBacktestDataProvenance(input.candles, input.securityData)
    };
}
