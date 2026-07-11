/** Build a byte-deterministic, random-access replay from an immutable report. */
export function createBacktestReplay(result) {
    const executionByBar = new Map();
    for (const event of result.executionTrace.events) {
        if (!("barIndex" in event))
            continue;
        const bucket = executionByBar.get(event.barIndex) ?? [];
        bucket.push(event);
        executionByBar.set(event.barIndex, bucket);
    }
    const equityByTime = new Map(result.equityCurve.map((point) => [point.time, point]));
    const frames = result.eventTrace.map((trace, cursor) => ({
        cursor,
        total: result.eventTrace.length,
        barIndex: trace.barIndex,
        barTime: trace.barTime,
        equity: equityAt(equityByTime, result.equityCurve, trace.barTime),
        strategyEvents: Object.freeze([...trace.events]),
        executionEvents: Object.freeze([...(executionByBar.get(trace.barIndex) ?? [])]),
        explanations: Object.freeze([...trace.explanations]),
        variableChanges: Object.freeze([...trace.variableChanges]),
        signals: Object.freeze(result.signals.filter((signal) => signal.time === trace.barTime)),
        tradesOpened: Object.freeze(result.trades.filter((trade) => trade.entryIndex === trace.barIndex)),
        tradesClosed: Object.freeze(result.trades.filter((trade) => trade.exitIndex === trace.barIndex))
    }));
    return Object.freeze({ schemaVersion: 1, frames: Object.freeze(frames) });
}
export function replayFrame(timeline, cursor) {
    if (!timeline.frames.length)
        return undefined;
    return timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.floor(cursor)))] ?? timeline.frames[0];
}
export function stepReplay(timeline, cursor, delta) {
    return replayFrame(timeline, cursor + delta);
}
function equityAt(byTime, points, time) {
    const exact = byTime.get(time);
    if (exact)
        return exact.equity;
    let found;
    for (const point of points) {
        if (point.time > time)
            break;
        found = point.equity;
    }
    return found;
}
