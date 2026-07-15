import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { BasisScan, InstrumentRegistryResponse, NativeSpreadContractType, NativeSpreadScan, PairwiseEvaluationRequest, PairwiseEvaluationResponse, PublicVenueDepthResponse, PublicVenueFundingResponse, PublicVenueInstrumentResponse, PublicVenueTickerResponse, PublicVenueTopBook, TriangularScan, VenueCapabilitiesResponse } from "./types.js";
import { type VenueClockHealth } from "./clockHealth.js";
import { type ContinuousRouteLiveResponse } from "./continuousRoutes.js";
import { type ContinuousFeedHealthResponse } from "./continuousFeedHealth.js";
import type { FundingCurveRequest, FundingCurveResponse, FundingCurveUniverseResponse } from "./fundingCurveTypes.js";
import { parseNativeSpreadScan } from "./nativeSpreads.js";
import type { NetworkIdentityRegistryResponse, NetworkTransferCompatibilityRequest, NetworkTransferCompatibilityResult } from "./networkIdentityTypes.js";
import type { OptionsParityEvaluationRequest, OptionsParityEvaluationResponse } from "./optionsParityTypes.js";
import { type LifecycleQuery, type LifecycleResponse } from "./lifecycle.js";
import type { NLegResearchRequest, NLegResearchResponse } from "./nLegTypes.js";
import type { TriangularDepthVerificationRequest, TriangularDepthVerificationResponse } from "./triangularDepthTypes.js";
export { parsePublicVenueDepth, parsePublicVenueFunding, parsePublicVenueInstruments, parsePublicVenueTickers, parsePublicVenueTopBook } from "./publicMarketData.js";
export { parseNativeSpreadScan };
export declare class ArbitrageSdkError extends Error {
    readonly status?: number;
    readonly kind: "cancelled" | "timeout" | "http" | "validation";
    constructor(message: string, status?: number, kind?: "cancelled" | "timeout" | "http" | "validation");
}
export interface ArbitrageClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxPayloadBytes?: number;
}
/** Public/read-only SDK. It intentionally contains no credential or order APIs. */
export declare class SaltanatArbitrageClient {
    private readonly baseUrl;
    private readonly fetcher;
    private readonly timeoutMs;
    private readonly maxPayloadBytes;
    constructor(options: ArbitrageClientOptions);
    basis(options?: {
        costBps?: number;
        minSpreadBps?: number;
        minCapacityUsd?: number;
        sort?: "expected-profit" | "net-edge" | "capacity";
        limit?: number;
    }, signal?: AbortSignal | undefined): Promise<BasisScan>;
    triangular(options: {
        venue: "binance" | "bybit";
        startAsset: string;
        startQuantity: number;
        takerFeeBps?: number;
        minimumNetReturnBps?: number;
        limit?: number;
    }, signal?: AbortSignal): Promise<TriangularScan>;
    verifyTriangularDepth(request: TriangularDepthVerificationRequest, signal?: AbortSignal): Promise<TriangularDepthVerificationResponse>;
    nativeSpreads(options?: {
        contractType?: NativeSpreadContractType;
        baseCoin?: string;
        minimumQuantity?: number;
        sort?: "capacity" | "tightness" | "freshness";
        maxCandidates?: number;
        limit?: number;
    }, signal?: AbortSignal | undefined): Promise<NativeSpreadScan>;
    optionsParity(request: OptionsParityEvaluationRequest, signal?: AbortSignal): Promise<OptionsParityEvaluationResponse>;
    pairwise(request: PairwiseEvaluationRequest, signal?: AbortSignal): Promise<PairwiseEvaluationResponse>;
    instruments(options?: {
        venue?: string;
        marketType?: RegistryInstrument["marketType"];
        symbol?: string;
        assetId?: string;
        status?: RegistryInstrument["status"];
        includeStale?: boolean;
        limit?: number;
    }, signal?: AbortSignal | undefined): Promise<InstrumentRegistryResponse>;
    venues(signal?: AbortSignal): Promise<VenueCapabilitiesResponse>;
    networkIdentityRegistry(signal?: AbortSignal): Promise<NetworkIdentityRegistryResponse>;
    networkTransferPreflight(request: NetworkTransferCompatibilityRequest, signal?: AbortSignal): Promise<NetworkTransferCompatibilityResult>;
    clockHealth(signal?: AbortSignal): Promise<VenueClockHealth>;
    lifecycle(options?: LifecycleQuery, signal?: AbortSignal): Promise<LifecycleResponse>;
    continuousRoutes(signal?: AbortSignal): Promise<ContinuousRouteLiveResponse>;
    continuousFeedHealth(signal?: AbortSignal): Promise<ContinuousFeedHealthResponse>;
    nLeg(request: NLegResearchRequest, signal?: AbortSignal): Promise<NLegResearchResponse>;
    fundingCurve(request: FundingCurveRequest, signal?: AbortSignal): Promise<FundingCurveResponse>;
    fundingCurveUniverse(signal?: AbortSignal): Promise<FundingCurveUniverseResponse>;
    venueInstruments(venue: string, options: {
        marketType: PublicVenueInstrumentResponse["marketType"];
        status?: string;
        assetId?: string;
        limit?: number;
    }, signal?: AbortSignal): Promise<PublicVenueInstrumentResponse>;
    venueTickers(venue: string, options: {
        marketType: PublicVenueTickerResponse["marketType"];
        limit?: number;
    }, signal?: AbortSignal): Promise<PublicVenueTickerResponse>;
    venueTicker(venue: string, options: {
        marketType: PublicVenueTopBook["marketType"];
        instrumentId: string;
    }, signal?: AbortSignal): Promise<PublicVenueTopBook & {
        readOnly: true;
    }>;
    venueDepth(venue: string, options: {
        marketType: PublicVenueDepthResponse["marketType"];
        instrumentId: string;
        limit?: number;
    }, signal?: AbortSignal): Promise<PublicVenueDepthResponse>;
    venueFunding(venue: string, options: {
        marketType: PublicVenueFundingResponse["marketType"];
        instrumentId: string;
        historyLimit?: number;
    }, signal?: AbortSignal): Promise<PublicVenueFundingResponse>;
    private get;
    private post;
    private request;
}
export declare function parseBasisScan(value: unknown): BasisScan;
export declare function parseTriangularScan(value: unknown): TriangularScan;
