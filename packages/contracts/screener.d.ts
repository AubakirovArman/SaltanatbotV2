import type { DataExchange, DataMarketType, Timeframe } from "./index.js";
/** Public, research-only technical screener contracts shared by the API and browser. */
export declare const SCREENER_DEFINITION_SCHEMA_V1: "screener-definition-v1";
export declare const SCREENER_RUN_REQUEST_SCHEMA_V1: "screener-run-request-v1";
export declare const SCREENER_RUN_RESULT_SCHEMA_V1: "screener-run-result-v1";
export declare const SCREENER_PRESET_LIST_SCHEMA_V1: "screener-preset-list-v1";
export declare const SCREENER_TIMEFRAMES_V1: readonly ["5m", "15m", "1h", "4h", "1d"];
export declare const SCREENER_SORT_KEYS_V1: readonly ["quoteVolume24h", "change24hPercent", "lastClose", "symbol", "rsi", "atrPercent"];
export declare const SCREENER_FILTER_KINDS_V1: readonly ["price", "quote-volume-24h", "change-24h-percent", "rsi", "ma-cross", "macd", "atr-percent"];
export declare const SCREENER_UNIVERSE_LIMIT_MINIMUM_V1 = 10;
export declare const SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1 = 200;
export declare const SCREENER_FILTER_LIMIT_V1 = 12;
export declare const SCREENER_RESULT_ROW_LIMIT_V1 = 100;
export type ScreenerDecimalV1 = string;
export type ScreenerTimeframeV1 = Extract<Timeframe, (typeof SCREENER_TIMEFRAMES_V1)[number]>;
/** MVP universe is Binance-only; the field keeps the shared venue taxonomy for later exchanges. */
export type ScreenerExchangeV1 = Extract<DataExchange, "binance">;
export type ScreenerMarketTypeV1 = Extract<DataMarketType, "spot">;
export type ScreenerSortKeyV1 = (typeof SCREENER_SORT_KEYS_V1)[number];
export type ScreenerSortDirectionV1 = "asc" | "desc";
export type ScreenerFilterKindV1 = (typeof SCREENER_FILTER_KINDS_V1)[number];
export type ScreenerMaTypeV1 = "ema" | "sma";
export type ScreenerMaCrossStateV1 = "fast-above" | "fast-below" | "crossed-up" | "crossed-down";
export type ScreenerMacdConditionV1 = "histogram-above-zero" | "histogram-below-zero" | "crossed-up" | "crossed-down";
export type ScreenerThresholdConditionV1 = "above" | "below";
export interface ScreenerPriceFilterV1 {
    kind: "price";
    min?: ScreenerDecimalV1;
    max?: ScreenerDecimalV1;
}
export interface ScreenerQuoteVolumeFilterV1 {
    kind: "quote-volume-24h";
    /** Minimum 24h quote-asset (USDT) turnover. */
    min: ScreenerDecimalV1;
}
export interface ScreenerChangePercentFilterV1 {
    kind: "change-24h-percent";
    min?: ScreenerDecimalV1;
    max?: ScreenerDecimalV1;
}
export interface ScreenerRsiFilterV1 {
    kind: "rsi";
    period: number;
    condition: ScreenerThresholdConditionV1;
    value: ScreenerDecimalV1;
}
export interface ScreenerMaCrossFilterV1 {
    kind: "ma-cross";
    fastType: ScreenerMaTypeV1;
    fastPeriod: number;
    slowType: ScreenerMaTypeV1;
    slowPeriod: number;
    state: ScreenerMaCrossStateV1;
}
export interface ScreenerMacdFilterV1 {
    kind: "macd";
    fast: number;
    slow: number;
    signal: number;
    condition: ScreenerMacdConditionV1;
}
export interface ScreenerAtrPercentFilterV1 {
    kind: "atr-percent";
    period: number;
    condition: ScreenerThresholdConditionV1;
    value: ScreenerDecimalV1;
}
export type ScreenerFilterV1 = ScreenerPriceFilterV1 | ScreenerQuoteVolumeFilterV1 | ScreenerChangePercentFilterV1 | ScreenerRsiFilterV1 | ScreenerMaCrossFilterV1 | ScreenerMacdFilterV1 | ScreenerAtrPercentFilterV1;
export interface ScreenerSortV1 {
    key: ScreenerSortKeyV1;
    direction: ScreenerSortDirectionV1;
}
export interface ScreenerDefinitionV1 {
    schemaVersion: typeof SCREENER_DEFINITION_SCHEMA_V1;
    kind: "technical";
    name: string;
    exchange: ScreenerExchangeV1;
    marketType: ScreenerMarketTypeV1;
    priceType: "last";
    timeframe: ScreenerTimeframeV1;
    universeLimit: number;
    sort: ScreenerSortV1;
    filters: ScreenerFilterV1[];
    researchOnly: true;
    executionPermission: false;
}
/** Exactly one of definition or presetId; the worker resolves presets at execution time. */
export interface ScreenerRunRequestV1 {
    schemaVersion: typeof SCREENER_RUN_REQUEST_SCHEMA_V1;
    definition?: ScreenerDefinitionV1;
    presetId?: string;
    researchOnly: true;
    executionPermission: false;
}
export interface ScreenerUniverseSummaryV1 {
    requested: number;
    evaluated: number;
    matched: number;
    unavailable: number;
}
/** Indicator outputs on the last closed bar. Missing values mean unavailable, never zero. */
export interface ScreenerRowMetricsV1 {
    rsi?: ScreenerDecimalV1;
    atrPercent?: ScreenerDecimalV1;
    macdHistogram?: ScreenerDecimalV1;
    fastMa?: ScreenerDecimalV1;
    slowMa?: ScreenerDecimalV1;
}
export interface ScreenerRowV1 {
    symbol: string;
    lastClose: ScreenerDecimalV1;
    closedBarTime: number;
    change24hPercent?: ScreenerDecimalV1;
    quoteVolume24h?: ScreenerDecimalV1;
    metrics: ScreenerRowMetricsV1;
    matchedFilters: number;
}
export interface ScreenerRunResultV1 {
    schemaVersion: typeof SCREENER_RUN_RESULT_SCHEMA_V1;
    definitionHash: string;
    generatedAt: string;
    timeframe: ScreenerTimeframeV1;
    closedBarTimeMin: number;
    closedBarTimeMax: number;
    universe: ScreenerUniverseSummaryV1;
    unavailableReasons: Record<string, number>;
    rows: ScreenerRowV1[];
    rowsTruncated: boolean;
    researchOnly: true;
    executionPermission: false;
}
/** Owner-scoped public projection. Hash and authorization internals are never exposed. */
export interface ScreenerPresetV1 {
    id: string;
    clientId: string;
    revision: number;
    definition: ScreenerDefinitionV1;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string;
    researchOnly: true;
    executionPermission: false;
}
export interface ScreenerPresetListV1 {
    schemaVersion: typeof SCREENER_PRESET_LIST_SCHEMA_V1;
    presets: ScreenerPresetV1[];
    generatedAt: string;
    researchOnly: true;
    executionPermission: false;
}
export declare function parseScreenerDefinitionV1(value: unknown): ScreenerDefinitionV1;
export declare function parseScreenerFilterV1(value: unknown, label?: string): ScreenerFilterV1;
export declare function parseScreenerRunRequestV1(value: unknown): ScreenerRunRequestV1;
export declare function parseScreenerRunResultV1(value: unknown): ScreenerRunResultV1;
export declare function parseScreenerRowV1(value: unknown, label?: string): ScreenerRowV1;
export declare function parseScreenerPresetV1(value: unknown, label?: string): ScreenerPresetV1;
export declare function parseScreenerPresetListV1(value: unknown): ScreenerPresetListV1;
