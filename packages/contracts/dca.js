/** Public, research-only DCA robot parameter contracts shared by the API and browser. */
export const DCA_PARAMS_SCHEMA_V1 = "dca-params-v1";
export const DCA_MAX_SAFETY_ORDERS_V1 = 25;
export const DCA_MAX_PRICE_DEVIATION_PCT_V1 = 50;
export const DCA_SCALE_MINIMUM_V1 = 0.1;
export const DCA_SCALE_MAXIMUM_V1 = 5;
export const DCA_MAX_COOLDOWN_SECONDS_V1 = 86_400;
export const DCA_MAX_CYCLE_DURATION_HOURS_V1 = 720;
/** Matches the fixed-micros paper money range: 1e15 micros = 1e9 USDT. */
export const DCA_QUOTE_MAXIMUM_V1 = 1_000_000_000;
export function parseDcaParamsV1(value, label = "dca params") {
    const input = object(value, label);
    exact(input, ["schemaVersion", "direction", "baseOrderQuote", "safetyOrderQuote", "maxSafetyOrders", "priceDeviationPct", "stepScale", "volumeScale", "takeProfitPct", "cooldownSeconds", "researchOnly", "executionPermission"], ["stopLossPct", "trailingTakeProfitPct", "maxCycleDurationHours"], label);
    safety(input, label);
    const takeProfitPct = bounded(input.takeProfitPct, `${label}.takeProfitPct`, 0, 100, { exclusiveMinimum: true });
    const result = {
        schemaVersion: DCA_PARAMS_SCHEMA_V1,
        direction: oneOf(input.direction, ["long", "short"], `${label}.direction`),
        baseOrderQuote: bounded(input.baseOrderQuote, `${label}.baseOrderQuote`, 0, DCA_QUOTE_MAXIMUM_V1, { exclusiveMinimum: true }),
        safetyOrderQuote: bounded(input.safetyOrderQuote, `${label}.safetyOrderQuote`, 0, DCA_QUOTE_MAXIMUM_V1, { exclusiveMinimum: true }),
        maxSafetyOrders: integer(input.maxSafetyOrders, `${label}.maxSafetyOrders`, 0, DCA_MAX_SAFETY_ORDERS_V1),
        priceDeviationPct: bounded(input.priceDeviationPct, `${label}.priceDeviationPct`, 0, DCA_MAX_PRICE_DEVIATION_PCT_V1, { exclusiveMinimum: true }),
        stepScale: bounded(input.stepScale, `${label}.stepScale`, DCA_SCALE_MINIMUM_V1, DCA_SCALE_MAXIMUM_V1),
        volumeScale: bounded(input.volumeScale, `${label}.volumeScale`, DCA_SCALE_MINIMUM_V1, DCA_SCALE_MAXIMUM_V1),
        takeProfitPct,
        cooldownSeconds: integer(input.cooldownSeconds, `${label}.cooldownSeconds`, 0, DCA_MAX_COOLDOWN_SECONDS_V1),
        researchOnly: true,
        executionPermission: false,
    };
    if (input.stopLossPct !== undefined)
        result.stopLossPct = bounded(input.stopLossPct, `${label}.stopLossPct`, 0, 100, { exclusiveMinimum: true });
    if (input.trailingTakeProfitPct !== undefined) {
        result.trailingTakeProfitPct = bounded(input.trailingTakeProfitPct, `${label}.trailingTakeProfitPct`, 0, takeProfitPct, { exclusiveMinimum: true });
    }
    if (input.maxCycleDurationHours !== undefined) {
        result.maxCycleDurationHours = integer(input.maxCycleDurationHours, `${label}.maxCycleDurationHours`, 1, DCA_MAX_CYCLE_DURATION_HOURS_V1);
    }
    return result;
}
/**
 * Worst-case committed capital in quote currency: the base order plus every
 * safety order filled, times a fee reserve, rounded UP to 6 decimals so the
 * reservation is always conservative. `feePct` is the versioned paper
 * fill-model commission (percent); server and browser must pass the same value.
 */
export function worstCaseDcaCapitalQuote(params, feePct) {
    if (typeof feePct !== "number" || !Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
        throw new Error("worst-case feePct must be a finite percentage from 0 to 100");
    }
    let committed = params.baseOrderQuote;
    let safety = params.safetyOrderQuote;
    for (let index = 1; index <= params.maxSafetyOrders; index += 1) {
        committed += safety;
        safety *= params.volumeScale;
    }
    return Math.ceil(committed * (1 + feePct / 100) * 1_000_000) / 1_000_000;
}
function safety(input, label) {
    if (input.schemaVersion !== DCA_PARAMS_SCHEMA_V1 || input.researchOnly !== true || input.executionPermission !== false) {
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
