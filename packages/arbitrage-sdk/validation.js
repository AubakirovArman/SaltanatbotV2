export function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
export function array(value, label, maximum) {
    if (!Array.isArray(value) || value.length > maximum)
        throw new Error(`${label} must be an array with at most ${maximum} rows`);
    return value;
}
export function text(value, label) {
    if (typeof value !== "string" || !value)
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
export function optionalText(value, label) {
    if (value === undefined)
        return undefined;
    return text(value, label);
}
export function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${label} must be finite`);
    return value;
}
export function positive(value, label) {
    const result = finite(value, label);
    if (result <= 0)
        throw new Error(`${label} must be positive`);
    return result;
}
export function nonNegative(value, label) {
    const result = finite(value, label);
    if (result < 0)
        throw new Error(`${label} must be non-negative`);
    return result;
}
export function integer(value, label) {
    const result = nonNegative(value, label);
    if (!Number.isSafeInteger(result))
        throw new Error(`${label} must be a non-negative integer`);
    return result;
}
export function bool(value, label) {
    if (typeof value !== "boolean")
        throw new Error(`${label} must be boolean`);
    return value;
}
export function exact(value, values, label) {
    if (typeof value !== "string" || !values.includes(value))
        throw new Error(`${label} is unsupported`);
    return value;
}
export function optionalFinite(value, label) {
    return value === undefined ? undefined : finite(value, label);
}
