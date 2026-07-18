/** Canonical chart drawing geometry shared by canvas, workspace documents and alert evaluators. */
export const CHART_GEOMETRY_KINDS_V1 = ["horizontal", "trend", "channel"];
export function parseChartAnchorV1(value, label = "chart anchor") {
    const input = object(value, label);
    exact(input, ["time", "price"], [], label);
    const time = finite(input.time, `${label}.time`);
    if (!Number.isSafeInteger(time) || time <= 0) {
        throw new Error(`${label}.time must be a positive epoch-millisecond integer`);
    }
    return { time, price: finite(input.price, `${label}.price`) };
}
export function parseHorizontalGeometryV1(value, label = "horizontal geometry") {
    const input = object(value, label);
    exact(input, ["kind", "price"], [], label);
    return {
        kind: literal(input.kind, "horizontal", `${label}.kind`),
        price: finite(input.price, `${label}.price`),
    };
}
export function parseTrendGeometryV1(value, label = "trend geometry") {
    const input = object(value, label);
    exact(input, ["kind", "a", "b"], [], label);
    return { kind: literal(input.kind, "trend", `${label}.kind`), ...baseLine(input, label) };
}
export function parseChannelGeometryV1(value, label = "channel geometry") {
    const input = object(value, label);
    exact(input, ["kind", "a", "b", "width"], [], label);
    const kind = literal(input.kind, "channel", `${label}.kind`);
    const line = baseLine(input, label);
    const width = finite(input.width, `${label}.width`);
    if (width === 0)
        throw new Error(`${label}.width must be a non-zero price offset`);
    return { kind, ...line, width };
}
export function parseChartGeometryV1(value, label = "chart geometry") {
    const input = object(value, label);
    const kind = input.kind;
    if (kind === "horizontal")
        return parseHorizontalGeometryV1(input, label);
    if (kind === "trend")
        return parseTrendGeometryV1(input, label);
    if (kind === "channel")
        return parseChannelGeometryV1(input, label);
    throw new Error(`${label}.kind is unsupported`);
}
function baseLine(input, label) {
    const a = parseChartAnchorV1(input.a, `${label}.a`);
    const b = parseChartAnchorV1(input.b, `${label}.b`);
    if (a.time === b.time)
        throw new Error(`${label} anchors must not share one time`);
    return { a, b };
}
function object(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function exact(input, required, optional, label) {
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    const missing = required.filter((key) => !(key in input));
    if (unknown.length > 0 || missing.length > 0)
        throw new Error(`${label} has missing or unknown fields`);
}
function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${label} must be a finite number`);
    return value;
}
function literal(value, expected, label) {
    if (value !== expected)
        throw new Error(`${label} must equal ${expected}`);
    return expected;
}
