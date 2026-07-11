export function securitySeriesKey(symbol, timeframe) {
    return `${normalizePart(symbol)}|${normalizePart(timeframe)}`;
}
export function getSecurityCandles(context, symbol, timeframe) {
    if (!context)
        return undefined;
    const keys = [
        securitySeriesKey(symbol, timeframe),
        `${symbol}:${timeframe}`,
        `${symbol}|${timeframe}`,
        `${symbol}/${timeframe}`
    ];
    for (const key of keys) {
        const value = context instanceof Map ? context.get(key) : context[key];
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
