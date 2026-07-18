import { IR_VERSION } from "@saltanatbotv2/strategy-core";
/** Compile only the closed, bounded grammar represented by StrategyGenome. */
export function compileStrategyGenome(genome) {
    const inputs = [];
    const addInput = (name, value, min, max, step) => {
        inputs.push({ name, value, defaultValue: value, min, max, step, optimizationEligible: true });
        return { k: "input", name };
    };
    const signal = compileSignal(genome.signal, genome.direction, addInput);
    const body = [
        { k: "size", mode: "equity_pct", value: addInput("position_pct", genome.risk.positionPct, 5, 100, 5) },
        { k: "stop", mode: genome.risk.stopMode, value: addRiskInput("stop_value", genome.risk.stopMode, "stop", genome.risk.stopValue, addInput) },
        { k: "target", mode: genome.risk.targetMode, value: addRiskInput("target_value", genome.risk.targetMode, "target", genome.risk.targetValue, addInput) },
        { k: "entry", direction: genome.direction, when: signal.entry },
        { k: "exit", when: signal.exit }
    ];
    return {
        name: `Generated ${signal.label} ${capitalize(genome.direction)}`,
        inputs,
        body,
        v: IR_VERSION
    };
}
function compileSignal(signal, direction, addInput) {
    const close = { k: "price", field: "close" };
    const entryDirection = direction === "long" ? "above" : "below";
    const exitDirection = direction === "long" ? "below" : "above";
    if (signal.variant === "ma-cross") {
        const fast = ma(signal.maKind, addInput("fast_period", signal.fastPeriod, 3, 60, 1), close);
        const slow = ma(signal.maKind, addInput("slow_period", signal.slowPeriod, signal.fastPeriod + 3, 250, 1), close);
        return { label: `${signal.maKind.toUpperCase()} cross`, entry: cross(entryDirection, fast, slow), exit: cross(exitDirection, fast, slow) };
    }
    if (signal.variant === "price-ma") {
        const average = ma(signal.maKind, addInput("ma_period", signal.period, 5, 250, 1), close);
        return { label: `price/${signal.maKind.toUpperCase()} trend`, entry: cross(entryDirection, close, average), exit: cross(exitDirection, close, average) };
    }
    if (signal.variant === "rsi-reentry") {
        const oscillator = { k: "rsi", period: addInput("rsi_period", signal.period, 5, 50, 1), source: close };
        const entryLevel = direction === "long" ? signal.trigger : 100 - signal.trigger;
        const exitLevel = direction === "long" ? signal.exitLevel : 100 - signal.exitLevel;
        return {
            label: "RSI mean reversion",
            entry: cross(entryDirection, oscillator, addInput("entry_level", entryLevel, direction === "long" ? 20 : 60, direction === "long" ? 40 : 80, 1)),
            exit: cross(direction === "long" ? "above" : "below", oscillator, addInput("exit_level", exitLevel, direction === "long" ? 50 : 25, direction === "long" ? 75 : 50, 1))
        };
    }
    if (signal.variant === "bollinger-fade") {
        const period = addInput("band_period", signal.period, 10, 100, 1);
        const deviation = addInput("band_deviation", signal.deviation, 1, 4, 0.25);
        const entryBand = bollinger(direction === "long" ? "lower" : "upper", period, deviation, close);
        const middle = bollinger("middle", period, deviation, close);
        return {
            label: "Bollinger mean reversion",
            entry: cross(direction === "long" ? "above" : "below", close, entryBand),
            exit: cross(direction === "long" ? "above" : "below", close, middle)
        };
    }
    if (signal.variant === "donchian") {
        const period = addInput("breakout_period", signal.period, 10, 250, 1);
        const boundary = {
            k: "extreme",
            kind: direction === "long" ? "highest" : "lowest",
            period,
            source: { k: "price", field: direction === "long" ? "high" : "low", offset: 1 }
        };
        const exitAverage = ma("ema", addInput("exit_period", signal.exitPeriod, 3, 100, 1), close);
        return { label: "Donchian breakout", entry: cross(entryDirection, close, boundary), exit: cross(exitDirection, close, exitAverage) };
    }
    if (signal.variant === "bollinger-break") {
        const period = addInput("band_period", signal.period, 10, 100, 1);
        const deviation = addInput("band_deviation", signal.deviation, 1, 4, 0.25);
        const entryBand = bollinger(direction === "long" ? "upper" : "lower", period, deviation, close);
        const middle = bollinger("middle", period, deviation, close);
        return { label: "Bollinger breakout", entry: cross(entryDirection, close, entryBand), exit: cross(exitDirection, close, middle) };
    }
    if (signal.variant === "roc") {
        const oscillator = { k: "roc", period: addInput("roc_period", signal.period, 2, 100, 1), source: close };
        const threshold = direction === "long" ? signal.threshold : -signal.threshold;
        return {
            label: "ROC momentum",
            entry: cross(entryDirection, oscillator, addInput("momentum_threshold", threshold, direction === "long" ? 0.25 : -10, direction === "long" ? 10 : -0.25, 0.25)),
            exit: cross(exitDirection, oscillator, { k: "num", v: 0 })
        };
    }
    const fastPeriod = addInput("macd_fast", signal.fastPeriod, 3, 24, 1);
    const slowPeriod = addInput("macd_slow", signal.slowPeriod, Math.max(20, signal.fastPeriod + 3), 80, 1);
    const signalPeriod = addInput("macd_signal", signal.signalPeriod, 2, 30, 1);
    const line = { k: "macd", line: "macd", fast: fastPeriod, slow: slowPeriod, signal: signalPeriod, source: close };
    const signalLine = { k: "macd", line: "signal", fast: fastPeriod, slow: slowPeriod, signal: signalPeriod, source: close };
    return { label: "MACD momentum", entry: cross(entryDirection, line, signalLine), exit: cross(exitDirection, line, signalLine) };
}
function addRiskInput(name, mode, kind, value, addInput) {
    if (kind === "stop")
        return mode === "percent" ? addInput(name, value, 0.5, 10, 0.25) : addInput(name, value, 0.5, 6, 0.25);
    return mode === "percent" ? addInput(name, value, 1, 30, 0.5) : addInput(name, value, 1, 12, 0.25);
}
function ma(kind, period, source) {
    return { k: "ma", kind, period, source };
}
function bollinger(band, period, dev, source) {
    return { k: "bollinger", band, period, dev, source };
}
function cross(dir, a, b) {
    return { k: "cross", dir, a, b };
}
function capitalize(value) {
    return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
