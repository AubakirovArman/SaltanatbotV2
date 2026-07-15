import { getSecurityDataEvidence, getSecuritySeriesStore } from "@saltanatbotv2/strategy-core";
function classify(source) {
    const name = source?.trim();
    if (!name)
        return { source: "Unlabelled candles", kind: "unknown" };
    const normalized = name.toLowerCase();
    if (normalized.includes("fallback"))
        return { source: name, kind: "fallback" };
    if (normalized.includes("synthetic"))
        return { source: name, kind: "synthetic" };
    return { source: name, kind: "real" };
}
function collect(candles, scope, counts) {
    for (const candle of candles) {
        const classified = classify(candle.source);
        const key = `${scope}\u0000${classified.kind}\u0000${classified.source}`;
        const current = counts.get(key);
        if (current)
            current.bars += 1;
        else
            counts.set(key, { scope, source: classified.source, kind: classified.kind, bars: 1 });
    }
}
/** Summarize every chart and request.security candle source used by a run. */
export function buildBacktestDataProvenance(chartCandles, securityData) {
    const counts = new Map();
    collect(chartCandles, "chart", counts);
    let securityBars = 0;
    const securityStore = getSecuritySeriesStore(securityData);
    const seenSecuritySeries = new Set();
    const securitySeries = securityStore instanceof Map
        ? securityStore.values()
        : Object.values(securityStore ?? {});
    for (const candles of securitySeries) {
        if (seenSecuritySeries.has(candles))
            continue;
        seenSecuritySeries.add(candles);
        securityBars += candles.length;
        collect(candles, "security", counts);
    }
    const securityRequests = snapshotSecurityEvidence(getSecurityDataEvidence(securityData));
    const sources = [...counts.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind));
    const fallbackBars = sources
        .filter((source) => source.kind === "fallback" || source.kind === "synthetic")
        .reduce((sum, source) => sum + source.bars, 0);
    const unknownBars = sources
        .filter((source) => source.kind === "unknown")
        .reduce((sum, source) => sum + source.bars, 0);
    const realBars = sources
        .filter((source) => source.kind === "real")
        .reduce((sum, source) => sum + source.bars, 0);
    const totalBars = chartCandles.length + securityBars;
    let status;
    if (totalBars === 0 || unknownBars === totalBars)
        status = "unknown";
    else if (fallbackBars === totalBars)
        status = "fallback";
    else if (realBars === totalBars)
        status = "real";
    else
        status = "mixed";
    return {
        status,
        sources,
        chartBars: chartCandles.length,
        securityBars,
        fallbackBars,
        unknownBars,
        ...(securityRequests ? { securityRequests } : {}),
        performanceClaimsValid: status === "real" && (securityRequests?.unresolved.length ?? 0) === 0
    };
}
function snapshotSecurityEvidence(evidence) {
    if (!evidence)
        return undefined;
    return {
        version: 1,
        requested: evidence.requested.map((request) => ({ ...request })),
        resolved: evidence.resolved.map((request) => ({ ...request, keys: [...request.keys] })),
        unresolved: evidence.unresolved.map((request) => ({ ...request }))
    };
}
