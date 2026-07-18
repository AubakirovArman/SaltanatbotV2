/** Public, research-only DCA robot parameter contracts shared by the API and browser. */
export declare const DCA_PARAMS_SCHEMA_V1: "dca-params-v1";
export declare const DCA_MAX_SAFETY_ORDERS_V1 = 25;
export declare const DCA_MAX_PRICE_DEVIATION_PCT_V1 = 50;
export declare const DCA_SCALE_MINIMUM_V1 = 0.1;
export declare const DCA_SCALE_MAXIMUM_V1 = 5;
export declare const DCA_MAX_COOLDOWN_SECONDS_V1 = 86400;
export declare const DCA_MAX_CYCLE_DURATION_HOURS_V1 = 720;
/** Matches the fixed-micros paper money range: 1e15 micros = 1e9 USDT. */
export declare const DCA_QUOTE_MAXIMUM_V1 = 1000000000;
export type DcaDirectionV1 = "long" | "short";
export interface DcaParamsV1 {
    schemaVersion: typeof DCA_PARAMS_SCHEMA_V1;
    direction: DcaDirectionV1;
    /** First (base) market order size in quote currency. */
    baseOrderQuote: number;
    /** First safety order size in quote currency. */
    safetyOrderQuote: number;
    /** Maximum number of safety orders per cycle (0 disables averaging adds). */
    maxSafetyOrders: number;
    /** Distance of the first safety order from the cycle entry, percent. */
    priceDeviationPct: number;
    /** Deviation multiplier applied to each subsequent safety order. */
    stepScale: number;
    /** Size multiplier applied to each subsequent safety order. */
    volumeScale: number;
    /** Take-profit distance from the average entry, percent. */
    takeProfitPct: number;
    /** Optional stop-loss distance from the average entry, percent. */
    stopLossPct?: number;
    /** Optional trailing distance once the take-profit threshold is reached. */
    trailingTakeProfitPct?: number;
    /** Pause after a completed cycle before the next entry, seconds. */
    cooldownSeconds: number;
    /** Optional cycle age limit; exceeding it closes at market and stops. */
    maxCycleDurationHours?: number;
    researchOnly: true;
    executionPermission: false;
}
export declare function parseDcaParamsV1(value: unknown, label?: string): DcaParamsV1;
/**
 * Worst-case committed capital in quote currency: the base order plus every
 * safety order filled, times a fee reserve, rounded UP to 6 decimals so the
 * reservation is always conservative. `feePct` is the versioned paper
 * fill-model commission (percent); server and browser must pass the same value.
 */
export declare function worstCaseDcaCapitalQuote(params: DcaParamsV1, feePct: number): number;
