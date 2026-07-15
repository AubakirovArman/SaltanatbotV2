import type { Candle } from "@saltanatbotv2/contracts";
/** Legacy/raw external-series storage accepted by every runtime entry point. */
export type SecuritySeriesStore = Map<string, Candle[]> | Record<string, Candle[]>;
export interface SecuritySeriesRequest {
    key: string;
    symbol: string;
    timeframe: string;
}
export interface ResolvedSecuritySeries extends SecuritySeriesRequest {
    fetchSymbol: string;
    fetchTimeframe: string;
    source: "chart" | "external";
    bars: number;
    keys: string[];
}
export interface UnresolvedSecuritySeries extends SecuritySeriesRequest {
    fetchSymbol?: string;
    fetchTimeframe?: string;
    reason: "empty-chart" | "unsupported-request" | "empty-response" | "load-error";
}
/**
 * Versioned evidence produced while resolving request.security() dependencies.
 * It intentionally contains no raw errors/URLs so exported reports stay safe
 * and deterministic.
 */
export interface SecurityDataEvidence {
    version: 1;
    requested: SecuritySeriesRequest[];
    resolved: ResolvedSecuritySeries[];
    unresolved: UnresolvedSecuritySeries[];
}
/** Rich context used by research/backtests while retaining raw-map compatibility. */
export interface SecurityDataBundle {
    series: SecuritySeriesStore;
    evidence: SecurityDataEvidence;
}
export type SecurityDataContext = SecuritySeriesStore | SecurityDataBundle;
export declare function createSecurityDataBundle(series: SecuritySeriesStore, evidence: SecurityDataEvidence): SecurityDataBundle;
export declare function isSecurityDataBundle(context: SecurityDataContext | undefined): context is SecurityDataBundle;
export declare function getSecuritySeriesStore(context: SecurityDataContext | undefined): SecuritySeriesStore | undefined;
export declare function getSecurityDataEvidence(context: SecurityDataContext | undefined): SecurityDataEvidence | undefined;
export declare function securitySeriesKey(symbol: string, timeframe: string): string;
export declare function getSecurityCandles(context: SecurityDataContext | undefined, symbol: string, timeframe: string): Candle[] | undefined;
export declare function alignSecuritySeries(chartCandles: Candle[], sourceCandles: Candle[], sourceValues: number[]): number[];
