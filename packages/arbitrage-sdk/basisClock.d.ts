export type BasisDataQuality = "fresh" | "stale" | "skewed" | "unverified";
export type BasisClockStatus = "calibrated" | "degraded" | "expired" | "unavailable";
export type BasisClockLegReason = "clock-unavailable" | "clock-not-calibrated" | "timestamp-definitely-future" | "timestamp-may-be-future" | "timestamp-stale";
export type BasisClockSkewReason = "clock-unavailable" | "clock-not-calibrated" | "skew-exceeded";
export interface BasisClockLeg {
    sourceId: string;
    clockStatus: BasisClockStatus;
    eligible: boolean;
    quality: "verified" | "degraded" | "unavailable";
    offsetLowerMs?: number;
    offsetUpperMs?: number;
    ageLowerMs?: number;
    ageUpperMs?: number;
    reason?: BasisClockLegReason;
}
export interface BasisClockCorrection {
    modelVersion: "venue-clock-v1";
    spot: BasisClockLeg;
    futures: BasisClockLeg;
    skewEligible: boolean;
    minimumPossibleSkewMs?: number;
    maximumPossibleSkewMs?: number;
    skewReason?: BasisClockSkewReason;
}
export interface BasisTimingInput {
    correction: unknown;
    capturedAt: number;
    spotExchange: string;
    futuresExchange: string;
    spotExchangeTs?: number;
    futuresExchangeTs?: number;
    spotReceivedAt: number;
    futuresReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
}
export declare function parseBasisOpportunityTiming(input: BasisTimingInput): {
    clockCorrection?: BasisClockCorrection;
    measuredQuality: BasisDataQuality;
};
