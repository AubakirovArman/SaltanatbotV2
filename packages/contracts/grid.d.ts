/** Public, research-only grid robot parameter contracts shared by the API and browser. */
export declare const GRID_PARAMS_SCHEMA_V1: "grid-params-v1";
export declare const GRID_LEVELS_MINIMUM_V1 = 2;
export declare const GRID_LEVELS_MAXIMUM_V1 = 50;
export declare const GRID_MAX_CYCLES_MAXIMUM_V1 = 10000;
export declare const GRID_MAX_COOLDOWN_SECONDS_V1 = 86400;
/** Matches the fixed-micros paper money range: 1e15 micros = 1e9 USDT. */
export declare const GRID_QUOTE_MAXIMUM_V1 = 1000000000;
/** Price bounds share the same conservative absolute cap as quote sizes. */
export declare const GRID_PRICE_MAXIMUM_V1 = 1000000000;
/** Sanity cap on upperBound/lowerBound for geometric spacing. */
export declare const GRID_GEOMETRIC_MAX_RATIO_V1 = 1000000;
export type GridModeV1 = "neutral" | "long" | "short";
export type GridSpacingV1 = "arithmetic" | "geometric";
/** "manual" is reserved for a later release; the v1 parser accepts only "off". */
export type GridRecenterV1 = "off" | "manual";
export type GridOutsideRangeActionV1 = "pause" | "stop";
export interface GridParamsV1 {
    schemaVersion: typeof GRID_PARAMS_SCHEMA_V1;
    mode: GridModeV1;
    /** Level spacing law inside [lowerBound, upperBound]. */
    spacing: GridSpacingV1;
    /** Inclusive range floor; level prices sit strictly inside the range. */
    lowerBound: number;
    /** Inclusive range ceiling; must be strictly above lowerBound. */
    upperBound: number;
    /** Number of BUY/SELL level lines placed strictly inside the range. */
    gridLevels: number;
    /** Order size per level in quote currency. */
    orderQuote: number;
    /** Recenter policy; the MVP has no auto-recenter, so only "off" parses. */
    recenter: GridRecenterV1;
    /** Price escaping the range pauses the grid (resume on re-entry) or stops it. */
    outsideRangeAction: GridOutsideRangeActionV1;
    /** Optional flatten-and-stop trigger; neutral/long below lowerBound, short above upperBound. */
    stopLossPrice?: number;
    /** Optional cap of completed buy-to-sell round trips; reaching it stops the grid. */
    maxCycles?: number;
    /** Delay before a level re-arms after its paired order fills, seconds. */
    cooldownSeconds: number;
    researchOnly: true;
    executionPermission: false;
}
export declare function parseGridParamsV1(value: unknown, label?: string): GridParamsV1;
/**
 * Deterministic level price ladder shared by the UI preview and the state
 * machine: `gridLevels` prices strictly inside (lowerBound, upperBound), for
 * i = 1..gridLevels with step denominator gridLevels + 1 —
 * arithmetic: lower + i * (upper - lower) / (levels + 1);
 * geometric: lower * (upper / lower) ^ (i / (levels + 1)).
 * Every price is canonically rounded to 6 decimals so replays are byte-stable.
 */
export declare function gridLevelPrices(params: GridParamsV1): number[];
/**
 * Worst-case committed capital in quote currency: every level simultaneously
 * holding a filled buy with no paired sell (neutral/long), times a fee reserve,
 * rounded UP to 6 decimals so the reservation is always conservative. Short
 * grids reserve the symmetric quote-denominated amount — the identical MVP
 * model — and resting-order margin is 0 under paper spot semantics, so the
 * bound is levels * orderQuote for every mode. `feePct` is the versioned paper
 * fill-model commission (percent); server and browser must pass the same value.
 */
export declare function worstCaseGridCapitalQuote(params: GridParamsV1, feePct: number): number;
