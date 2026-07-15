import type { Candle } from "@saltanatbotv2/contracts";
import { type SecurityDataContext, type SecurityDataEvidence } from "@saltanatbotv2/strategy-core";
export type DataSourceKind = "real" | "fallback" | "synthetic" | "unknown";
export type DataProvenanceStatus = "real" | "fallback" | "mixed" | "unknown";
export interface DataProvenanceSource {
    scope: "chart" | "security";
    source: string;
    kind: DataSourceKind;
    bars: number;
}
export interface BacktestDataProvenance {
    status: DataProvenanceStatus;
    sources: DataProvenanceSource[];
    chartBars: number;
    securityBars: number;
    fallbackBars: number;
    unknownBars: number;
    /** Resolution evidence is additive so legacy serialized reports remain readable. */
    securityRequests?: SecurityDataEvidence;
    /** False means the run may still be useful for UI/testing, but not for performance claims. */
    performanceClaimsValid: boolean;
}
/** Summarize every chart and request.security candle source used by a run. */
export declare function buildBacktestDataProvenance(chartCandles: Candle[], securityData?: SecurityDataContext): BacktestDataProvenance;
