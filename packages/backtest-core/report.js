import { computeBacktestMetrics } from "./metrics.js";
import { buildBacktestExecutionTrace } from "./executionTrace.js";
import { buildBacktestDataProvenance } from "./provenance.js";
import { DEFAULT_BACKTEST_CONFIG as DEFAULT_CONFIG } from "./types.js";
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
    const provenance = buildBacktestDataProvenance(input.candles, input.securityData);
    const config = Object.freeze({ ...DEFAULT_CONFIG, ...input.config });
    const dataQuality = inspectBacktestDataQuality(input.candles, input.context?.requestedBars);
    const identity = {
        symbol: input.context?.symbol ?? "unknown",
        timeframe: input.context?.timeframe ?? "unknown",
        exchange: input.context?.exchange ?? "unknown",
        marketType: input.context?.marketType ?? "unknown",
        priceType: input.context?.priceType ?? "trade",
        strategyHash: input.context?.strategyHash ?? stableHash(input.name),
        provenanceFingerprint: stableHash(stableStringify(provenance)),
        dataRange: Object.freeze({
            fromTime: input.candles[0]?.time ?? 0,
            toTime: input.candles.at(-1)?.time ?? 0
        }),
        config,
        dataQuality
    };
    const comparisonKey = stableHash(stableStringify(identity));
    const metadata = Object.freeze({
        schemaVersion: 1,
        engine: "saltanat-backtest",
        engineVersion: 1,
        ...identity,
        assumptions: Object.freeze(fillAssumptions(config)),
        comparisonKey
    });
    return {
        schemaVersion: 1,
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
        executionTrace: buildBacktestExecutionTrace(input.executionEvents, provenance),
        provenance,
        metadata
    };
}
export function inspectBacktestDataQuality(candles, requestedBars) {
    const deltas = candles.slice(1).map((candle, index) => candle.time - candles[index].time).filter((delta) => delta > 0).sort((a, b) => a - b);
    const expectedIntervalMs = deltas.length ? deltas[Math.floor((deltas.length - 1) / 2)] : undefined;
    const gaps = [];
    let missingBars = 0;
    let gapsTruncated = false;
    if (expectedIntervalMs) {
        for (let index = 1; index < candles.length; index += 1) {
            const delta = candles[index].time - candles[index - 1].time;
            const missing = Math.max(0, Math.round(delta / expectedIntervalMs) - 1);
            if (!missing)
                continue;
            missingBars += missing;
            if (gaps.length < 20)
                gaps.push({ afterTime: candles[index - 1].time, beforeTime: candles[index].time, missingBars: missing });
            else
                gapsTruncated = true;
        }
    }
    return Object.freeze({
        loadedBars: candles.length,
        ...(requestedBars === undefined ? {} : { requestedBars }),
        partiallyLoaded: requestedBars !== undefined && candles.length < requestedBars,
        ...(expectedIntervalMs === undefined ? {} : { expectedIntervalMs }),
        missingBars,
        gaps: Object.freeze(gaps),
        gapsTruncated
    });
}
export function compareBacktestReports(left, right) {
    if (left.metadata.comparisonKey === right.metadata.comparisonKey)
        return { comparable: true, differences: [] };
    const fields = [
        "symbol", "timeframe", "exchange", "marketType", "priceType", "strategyHash", "provenanceFingerprint"
    ];
    const differences = fields.filter((field) => left.metadata[field] !== right.metadata[field]);
    if (stableStringify(left.metadata.config) !== stableStringify(right.metadata.config))
        differences.push("config");
    if (stableStringify(left.metadata.dataRange) !== stableStringify(right.metadata.dataRange))
        differences.push("dataRange");
    if (stableStringify(left.metadata.dataQuality) !== stableStringify(right.metadata.dataQuality))
        differences.push("dataQuality");
    return { comparable: false, differences };
}
export function createBacktestResearchFile(report, exportedAt = Date.now()) {
    return { schemaVersion: 1, kind: "saltanat-backtest-report", exportedAt, report };
}
export function serializeBacktestResearchFile(report, exportedAt = Date.now()) {
    return `${JSON.stringify(createBacktestResearchFile(report, exportedAt), null, 2)}\n`;
}
export function createStrategyFingerprint(strategy) {
    return stableHash(stableStringify(strategy));
}
function fillAssumptions(config) {
    return [
        config.fillTiming === "next_open" ? "Signals fill at the next bar open." : "Signals fill at the same bar close.",
        "When stop and target are both touched in one candle, the stop fills first.",
        "Stop orders are gap-aware market fills with configured slippage; targets are gap-aware limit fills.",
        `Commission is ${config.commissionPct}% per fill and slippage is ${config.slippagePct}%.`,
        `Funding/borrow is ${config.fundingRatePctPer8h}% per 8h, prorated by inferred bar duration.`,
        `Positions are capped at ${config.maxLeverage}x leverage and one net position at a time.`,
        "Liquidation occurs when realised equity plus worst intrabar unrealised PnL reaches zero.",
        "Open positions are force-closed on the final candle for reporting."
    ];
}
function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
