/** Public, research-only grid robot parameter contracts shared by the API and browser. */
export const GRID_PARAMS_SCHEMA_V1 = "grid-params-v1";
export const GRID_LEVELS_MINIMUM_V1 = 2;
export const GRID_LEVELS_MAXIMUM_V1 = 50;
export const GRID_MAX_CYCLES_MAXIMUM_V1 = 10_000;
export const GRID_MAX_COOLDOWN_SECONDS_V1 = 86_400;
/** Matches the fixed-micros paper money range: 1e15 micros = 1e9 USDT. */
export const GRID_QUOTE_MAXIMUM_V1 = 1_000_000_000;
/** Price bounds share the same conservative absolute cap as quote sizes. */
export const GRID_PRICE_MAXIMUM_V1 = 1_000_000_000;
/** Sanity cap on upperBound/lowerBound for geometric spacing. */
export const GRID_GEOMETRIC_MAX_RATIO_V1 = 1_000_000;
export function parseGridParamsV1(value, label = "grid params") {
    const input = object(value, label);
    exact(input, ["schemaVersion", "mode", "spacing", "lowerBound", "upperBound", "gridLevels", "orderQuote", "outsideRangeAction", "cooldownSeconds", "researchOnly", "executionPermission"], ["recenter", "stopLossPrice", "maxCycles"], label);
    safety(input, label);
    if (input.recenter !== undefined && input.recenter !== "off") {
        throw new Error(`${label}.recenter only supports "off" in grid-params-v1`);
    }
    const mode = oneOf(input.mode, ["neutral", "long", "short"], `${label}.mode`);
    const spacing = oneOf(input.spacing, ["arithmetic", "geometric"], `${label}.spacing`);
    const lowerBound = bounded(input.lowerBound, `${label}.lowerBound`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
    const upperBound = bounded(input.upperBound, `${label}.upperBound`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
    if (lowerBound >= upperBound)
        throw new Error(`${label}.lowerBound must be strictly below upperBound`);
    if (spacing === "geometric" && upperBound / lowerBound > GRID_GEOMETRIC_MAX_RATIO_V1) {
        throw new Error(`${label} geometric bounds ratio is out of bounds`);
    }
    const result = {
        schemaVersion: GRID_PARAMS_SCHEMA_V1,
        mode,
        spacing,
        lowerBound,
        upperBound,
        gridLevels: integer(input.gridLevels, `${label}.gridLevels`, GRID_LEVELS_MINIMUM_V1, GRID_LEVELS_MAXIMUM_V1),
        orderQuote: bounded(input.orderQuote, `${label}.orderQuote`, 0, GRID_QUOTE_MAXIMUM_V1, { exclusiveMinimum: true }),
        recenter: "off",
        outsideRangeAction: oneOf(input.outsideRangeAction, ["pause", "stop"], `${label}.outsideRangeAction`),
        cooldownSeconds: integer(input.cooldownSeconds, `${label}.cooldownSeconds`, 0, GRID_MAX_COOLDOWN_SECONDS_V1),
        researchOnly: true,
        executionPermission: false,
    };
    if (input.stopLossPrice !== undefined) {
        const stopLossPrice = bounded(input.stopLossPrice, `${label}.stopLossPrice`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
        if (mode === "short" ? stopLossPrice <= upperBound : stopLossPrice >= lowerBound) {
            throw new Error(`${label}.stopLossPrice must sit beyond the ${mode === "short" ? "upper" : "lower"} bound for ${mode} grids`);
        }
        result.stopLossPrice = stopLossPrice;
    }
    if (input.maxCycles !== undefined) {
        result.maxCycles = integer(input.maxCycles, `${label}.maxCycles`, 1, GRID_MAX_CYCLES_MAXIMUM_V1);
    }
    return result;
}
/**
 * Deterministic level price ladder shared by the UI preview and the state
 * machine: `gridLevels` prices strictly inside (lowerBound, upperBound), for
 * i = 1..gridLevels with step denominator gridLevels + 1 —
 * arithmetic: lower + i * (upper - lower) / (levels + 1);
 * geometric: lower * (upper / lower) ^ (i / (levels + 1)).
 * Every price is canonically rounded to 6 decimals so replays are byte-stable.
 */
export function gridLevelPrices(params) {
    const { lowerBound, upperBound, gridLevels, spacing } = params;
    const step = gridLevels + 1;
    const prices = [];
    for (let index = 1; index <= gridLevels; index += 1) {
        const price = spacing === "arithmetic"
            ? lowerBound + (index * (upperBound - lowerBound)) / step
            : lowerBound * (upperBound / lowerBound) ** (index / step);
        prices.push(Math.round(price * 1_000_000) / 1_000_000);
    }
    return prices;
}
/**
 * Worst-case committed capital in quote currency: every level simultaneously
 * holding a filled buy with no paired sell (neutral/long), times a fee reserve,
 * rounded UP to 6 decimals so the reservation is always conservative. Short
 * grids reserve the symmetric quote-denominated amount — the identical MVP
 * model — and resting-order margin is 0 under paper spot semantics, so the
 * bound is levels * orderQuote for every mode. `feePct` is the versioned paper
 * fill-model commission (percent); server and browser must pass the same value.
 */
export function worstCaseGridCapitalQuote(params, feePct) {
    if (typeof feePct !== "number" || !Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
        throw new Error("worst-case feePct must be a finite percentage from 0 to 100");
    }
    const committed = params.gridLevels * params.orderQuote;
    return Math.ceil(committed * (1 + feePct / 100) * 1_000_000) / 1_000_000;
}
function safety(input, label) {
    if (input.schemaVersion !== GRID_PARAMS_SCHEMA_V1 || input.researchOnly !== true || input.executionPermission !== false) {
        throw new Error(`${label} violates its versioned research-only safety envelope`);
    }
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
function integer(value, label, minimum, maximum) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} is out of bounds`);
    return value;
}
function bounded(value, label, minimum, maximum, options = {}) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${label} must be a finite number`);
    if (value > maximum || value < minimum || (options.exclusiveMinimum && value === minimum))
        throw new Error(`${label} is out of bounds`);
    return value;
}
function oneOf(value, allowed, label) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${label} is unsupported`);
    return value;
}
