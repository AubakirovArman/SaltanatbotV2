import type { RegistryInstrument } from "@saltanatbotv2/contracts";
export type FundingCurveRateUnit = "decimal-per-settlement";
export type FundingCurveStressUnit = "basis-points-additive-per-settlement";
export interface FundingCurveUniverseResponse {
    engine: "funding-curve-universe-v1";
    readOnly: true;
    researchOnly: true;
    executable: false;
    updatedAt: number;
    stale: boolean;
    contract: {
        owner: "server";
        adapterRegistry: "publicVenueAdapters";
        instruments: "fresh-verified-trading-perpetuals";
        execution: "none";
    };
    economicIdentityCatalog: {
        schemaVersion: 1;
        source: string;
        version: string;
        asOf: number;
        validUntil: number;
    };
    supportedVenues: string[];
    total: number;
    truncated: boolean;
    instruments: RegistryInstrument[];
    sourceErrors: string[];
}
export interface FundingCurveSelection {
    venue: string;
    instrumentId: string;
    marketType: "perpetual";
    rateUnit: FundingCurveRateUnit;
}
export interface FundingCurveStressScenario {
    id: string;
    bumpBps: number;
    unit: FundingCurveStressUnit;
}
export interface FundingCurveRequest {
    selections: readonly FundingCurveSelection[];
    horizon: {
        value: number;
        unit: "minutes";
    };
    historyLimit?: number;
    maxAgeMs?: number;
    maxFutureSkewMs?: number;
    maxCrossVenueClockSkewMs?: number;
    stressScenarios: readonly FundingCurveStressScenario[];
}
export interface FundingCurveHistoryPoint {
    settlementAt: number;
    estimateRate: number;
    realizedRate?: number;
    effectiveRate: number;
    rateKind: "estimate" | "realized";
    rateUnit: FundingCurveRateUnit;
    formulaType?: string;
    method?: string;
}
export interface FundingCurveSettlementPoint {
    settlementAt: number;
    baseRate: number;
    baseRateBps: number;
    rateUnit: FundingCurveRateUnit;
    rateSource: "current-estimate" | "next-estimate" | "latest-estimate-persistence";
}
export interface FundingCurveScenarioProjection {
    id: string;
    bumpBps: number;
    unit: FundingCurveStressUnit;
    settlementCount: number;
    cumulativeRate: number;
    averageRatePerSettlement: number;
    outsidePublishedMinimumCount: number;
    outsidePublishedMaximumCount: number;
}
export interface FundingCurveCalibratedClockLeg {
    sourceId: string;
    exchangeTs: number;
    clockStatus: "calibrated";
    ageLowerMs: number;
    ageUpperMs: number;
    localEventEarliestAt: number;
    localEventLatestAt: number;
}
export interface FundingCurveResult {
    venue: string;
    instrumentId: string;
    marketType: "perpetual";
    rateUnit: FundingCurveRateUnit;
    rateSignConvention: "positive-longs-pay-shorts";
    projectionSemantics: "rate-sum-only-no-notional-or-pnl";
    freshness: {
        status: "fresh";
        observedAt: number;
        ageMs: number;
        maxAgeMs: number;
    } & ({
        clockBasis: "calibrated-venue-interval";
        crossVenueComparable: true;
        ageLowerMs: number;
        ageUpperMs: number;
        clockLeg: FundingCurveCalibratedClockLeg;
    } | {
        clockBasis: "local-receipt-fallback";
        crossVenueComparable: false;
        fallbackReason: "clock-provider-unavailable" | "clock-unavailable" | "clock-not-calibrated" | "source-declared-local-receipt";
    });
    schedule: {
        verified: true;
        interval: number;
        unit: "minutes";
        fundingTime: number;
        nextFundingTime: number;
    };
    current: {
        settlementAt: number;
        estimateRate: number;
        estimateRateBps: number;
        rateUnit: FundingCurveRateUnit;
        nextEstimateRate?: number;
        nextEstimateRateBps?: number;
        minimumRate?: number;
        maximumRate?: number;
    };
    history: FundingCurveHistoryPoint[];
    settlements: FundingCurveSettlementPoint[];
    scenarios: FundingCurveScenarioProjection[];
    source: {
        adapter: "publicVenueAdapters";
        operation: "funding";
        public: true;
        credentialed: false;
        exchangeTs: number;
        receivedAt: number;
        formulaType?: string;
        method?: string;
        network?: "mainnet" | "testnet";
        currentEstimateSource?: string;
        timestampSource?: "exchange" | "local-receive";
        historyComplete: boolean;
        sourceErrors: string[];
        sourceErrorsTruncated: boolean;
    };
}
export type FundingCurveRejectionCode = "venue-unavailable" | "funding-unsupported" | "unsupported-rate-unit" | "identity-mismatch" | "stale-source" | "future-source-time" | "unverified-schedule" | "unsupported-schedule" | "invalid-source" | "projection-too-large" | "upstream-unavailable";
export interface FundingCurveRejection {
    venue: string;
    instrumentId: string;
    code: FundingCurveRejectionCode;
    message: string;
    retryable: boolean;
}
export interface FundingCurveResponse {
    engine: "funding-curve-v1";
    readOnly: true;
    researchOnly: true;
    executable: false;
    evaluatedAt: number;
    horizonEnd: number;
    contract: {
        source: "credential-free-public-venue-adapters";
        rateUnit: FundingCurveRateUnit;
        stressUnit: FundingCurveStressUnit;
        scheduleRequirement: "adapter-verified-discrete-settlements";
        projection: "point-in-time-estimate-persistence";
        pnl: "not-computed-without-explicit-notional-and-price-path";
        execution: "none";
    };
    crossVenueClock: {
        status: "not-applicable";
        eligible: false;
        reason: "fewer-than-two-successful-venues";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
    } | {
        status: "blocked";
        eligible: false;
        reason: "clock-not-calibrated" | "skew-exceeded";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
        maximumPossibleSkewMs?: number;
    } | {
        status: "eligible";
        eligible: true;
        clockBasis: "calibrated-venue-interval";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
        maximumPossibleSkewMs: number;
    };
    curves: FundingCurveResult[];
    rejections: FundingCurveRejection[];
}
