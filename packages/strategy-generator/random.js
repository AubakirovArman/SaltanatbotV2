/** Mulberry32 keeps runs independent of clock and global Math.random state. */
export function createGeneratorRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}
export function pick(values, random) {
    if (!values.length)
        throw new Error("Cannot pick from an empty generator choice set");
    return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}
export function randomInt(random, min, max, step = 1) {
    const safeStep = Math.max(1, Math.floor(step));
    const slots = Math.floor((max - min) / safeStep) + 1;
    return min + Math.floor(random() * slots) * safeStep;
}
export function randomDecimal(random, min, max, step) {
    const slots = Math.floor((max - min) / step) + 1;
    return canonicalNumber(min + Math.floor(random() * slots) * step);
}
export function canonicalNumber(value) {
    if (!Number.isFinite(value))
        throw new Error("Generator values must be finite");
    return Object.is(value, -0) ? 0 : Number.parseFloat(value.toPrecision(12));
}
export const ALL_FAMILIES = ["trend", "mean-reversion", "breakout", "momentum"];
export const ALL_DIRECTIONS = ["long", "short"];
export const ALL_MA_KINDS = ["sma", "ema", "wma"];
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function boundedInt(value, fallback, min, max) {
    return Math.floor(clamp(Number.isFinite(value) ? value : fallback, min, max));
}
export function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
