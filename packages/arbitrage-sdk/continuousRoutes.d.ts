import type { ContinuousMarketEconomicsSummary, ContinuousMarketEvaluation } from "./continuousMarketEconomicsTypes.js";
export type * from "./continuousMarketEconomicsTypes.js";
declare const ROUTE_FAMILIES: readonly ["cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future"];
declare const MARKET_TYPES: readonly ["spot", "perpetual", "future"];
declare const FEED_STATES: readonly ["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"];
export type ContinuousRouteRuntimeState = "disabled" | "starting" | "live" | "degraded" | "error";
export type ContinuousRouteFamily = (typeof ROUTE_FAMILIES)[number];
export interface ContinuousRouteRuntimeCoverage {
    complete: boolean;
    current: boolean;
    retainedPriorDiscovery: boolean;
    reason: "complete" | "configuration-disabled" | "configuration-invalid" | "refresh-pending" | "refresh-failed" | "partial-instruments";
}
export interface ContinuousRouteCandidate {
    routeKey: string;
    routeId: string;
    family: ContinuousRouteFamily;
    longInstrumentId: string;
    shortInstrumentId: string;
    longMarketType: (typeof MARKET_TYPES)[number];
    shortMarketType: (typeof MARKET_TYPES)[number];
    economicAssetId: string;
    edgeKind: "research-candidate";
    executable: false;
}
export interface ContinuousRouteTopBook {
    venue: string;
    instrumentId: string;
    marketType: (typeof MARKET_TYPES)[number];
    bid: number;
    bidSize: number;
    ask: number;
    askSize: number;
    exchangeTs: number;
    receivedAt: number;
    continuity: "sequence-verified" | "checksum-verified" | "sequence-observed" | "atomic-snapshot";
}
export interface ContinuousRouteFunding {
    venue: string;
    instrumentId: string;
    currentEstimateRate: number;
    nextEstimateRate?: number;
    nextFundingTime?: number;
    intervalMinutes?: number;
    scheduleVerified: boolean;
    exchangeTs?: number;
    exchangeTimestampVerified: boolean;
    receivedAt: number;
}
export interface ContinuousRouteSource {
    venue: string;
    instrumentId: string;
    marketType: (typeof MARKET_TYPES)[number];
    state: (typeof FEED_STATES)[number];
    message: string;
    generation: number;
    hasBook: boolean;
    hasTopBook: boolean;
    hasFunding: boolean;
}
export interface ContinuousRouteLiveResponse {
    schemaVersion: 1;
    engine: "continuous-route-runtime-v1";
    readOnly: true;
    executionStatus: "research-only";
    executable: false;
    configurationSource: "operator-environment";
    state: ContinuousRouteRuntimeState;
    /** Absent only on an older compatible server. New runtimes always publish this fail-closed coverage state. */
    coverage?: ContinuousRouteRuntimeCoverage;
    evaluatedAt: number;
    refreshedAt?: number;
    configuredInstrumentIds: string[];
    activeInstrumentIds: string[];
    unavailable: Array<{
        instrumentId: string;
        reason: string;
    }>;
    message?: string;
    discovery: {
        engine: "continuous-route-discovery-v1";
        capturedAt: number;
        totalCompatibleCandidates: number;
        truncated: boolean;
        candidates: ContinuousRouteCandidate[];
        marketEconomics?: ContinuousMarketEconomicsSummary;
        marketEvaluations?: ContinuousMarketEvaluation[];
        routeReadyBookCount: number;
        topBooks: ContinuousRouteTopBook[];
        fundingObservations: ContinuousRouteFunding[];
        excludedBooks: Array<{
            instrumentId: string;
            reason: string;
        }>;
        rejectedInstruments: Array<{
            instrumentId?: string;
            code: string;
            message: string;
        }>;
        sources: ContinuousRouteSource[];
    };
}
/**
 * Parses the read-only live discovery response and deliberately returns a bounded
 * observation view. Full depth remains server-side; the SDK exposes only health,
 * top books, funding and candidate identity and never exposes an execution path.
 */
export declare function parseContinuousRouteLiveResponse(value: unknown): ContinuousRouteLiveResponse;
