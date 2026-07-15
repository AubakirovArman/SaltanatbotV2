export function createSecurityDataBundle(series, evidence) {
    return { series, evidence };
}
export function isSecurityDataBundle(context) {
    if (!context || context instanceof Map || Array.isArray(context))
        return false;
    const candidate = context;
    return candidate.evidence?.version === 1
        && Array.isArray(candidate.evidence.requested)
        && Array.isArray(candidate.evidence.resolved)
        && Array.isArray(candidate.evidence.unresolved)
        && candidate.series !== undefined;
}
export function getSecuritySeriesStore(context) {
    return isSecurityDataBundle(context) ? context.series : context;
}
export function getSecurityDataEvidence(context) {
    return isSecurityDataBundle(context) ? context.evidence : undefined;
}
export function securitySeriesKey(symbol, timeframe) {
    return `${normalizePart(symbol)}|${normalizeTimeframePart(timeframe)}`;
}
export function getSecurityCandles(context, symbol, timeframe) {
    const store = getSecuritySeriesStore(context);
    if (!store)
        return undefined;
    const keys = [
        securitySeriesKey(symbol, timeframe),
        `${symbol}:${timeframe}`,
        `${symbol}|${timeframe}`,
        `${symbol}/${timeframe}`
    ];
    for (const key of keys) {
        const value = store instanceof Map ? store.get(key) : store[key];
        if (value?.length)
            return value;
    }
    return undefined;
}
export function alignSecuritySeries(chartCandles, sourceCandles, sourceValues) {
    const out = new Array(chartCandles.length).fill(NaN);
    let srcIdx = -1;
    for (let i = 0; i < chartCandles.length; i += 1) {
        const t = chartCandles[i].time;
        while (srcIdx + 1 < sourceCandles.length && sourceCandles[srcIdx + 1].time <= t)
            srcIdx += 1;
        if (srcIdx >= 0)
            out[i] = sourceValues[srcIdx] ?? NaN;
    }
    return out;
}
function normalizePart(value) {
    return value.trim().toUpperCase() || "CURRENT";
}
function normalizeTimeframePart(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return "CURRENT";
    // The app uses lowercase `m` for minutes and uppercase `M` for months.
    // Uppercasing the entire key silently aliased e.g. 1m and 1M.
    if (/^\d+m$/.test(trimmed))
        return trimmed;
    return trimmed.toUpperCase();
}
