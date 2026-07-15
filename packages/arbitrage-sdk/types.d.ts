import type { RegistryInstrument, VenueCapabilityManifest, VenueFundingMarketType, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { PairwiseRoute } from "./pairwiseRouteTypes.js";
import type { BasisClockCorrection } from "./basisClock.js";
import type { BasisIdentityCoverage } from "./basisCoverage.js";
export type * from "./pairwiseRouteTypes.js";
export type { BasisClockCorrection, BasisClockLeg, BasisClockLegReason, BasisClockSkewReason, BasisClockStatus } from "./basisClock.js";
export type { BasisIdentityCoverage } from "./basisCoverage.js";
export type { VenueClockHealth, VenueClockHealthSource, VenueClockStatus } from "./clockHealth.js";
export type BasisVenue = "binance" | "bybit";
export interface BasisOpportunity {
    id: string;
    strategyKind: "cash-and-carry";
    edgeKind: "projected";
    identityScope: "venue-native" | "cross-venue-reviewed";
    symbol: string;
    assetId: string;
    spotInstrumentId: string;
    futuresInstrumentId: string;
    spotExchange: BasisVenue;
    futuresExchange: BasisVenue;
    spotBid: number;
    spotAsk: number;
    spotAskSize: number;
    futuresBid: number;
    futuresAsk: number;
    futuresBidSize: number;
    grossSpreadBps: number;
    estimatedTotalCostBps: number;
    netEdgeBps: number;
    topBookCapacityUsd: number;
    topBookMatchedQuantity: number;
    expectedNetProfitUsd: number;
    fundingRate: number;
    fundingScheduleVerified: boolean;
    nextFundingTime?: number;
    fundingIntervalMinutes?: number;
    spotExchangeTs?: number;
    spotExchangeTimestampVerified: boolean;
    spotReceivedAt: number;
    futuresExchangeTs?: number;
    futuresExchangeTimestampVerified: boolean;
    futuresReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
    dataQuality: "fresh" | "stale" | "skewed" | "unverified";
    clockCorrection?: BasisClockCorrection;
    capturedAt: number;
}
export interface BasisScan {
    updatedAt: number;
    stale: boolean;
    scannedSymbols: number;
    totalOpportunities: number;
    truncated: boolean;
    estimatedTotalCostBps: number;
    opportunities: BasisOpportunity[];
    sources: Array<{
        exchange: BasisVenue;
        market: "spot" | "perpetual";
        ok: boolean;
        message?: string;
    }>;
    identityCoverage?: BasisIdentityCoverage;
}
export interface TriangularLeg {
    index: 0 | 1 | 2;
    symbol: string;
    side: "buy" | "sell";
    fromAsset: string;
    toAsset: string;
    inputQuantity: number;
    outputQuantity: number;
    averagePrice: number;
    feeBps: number;
    levelsUsed: number;
}
export interface TriangularOpportunity {
    id: string;
    edgeKind: "non-executable-candidate";
    executionStatus: "non-executable-candidate";
    marketDataMode: "rest-top-book";
    sequenceVerified: false;
    venue: BasisVenue;
    startAsset: string;
    startQuantity: number;
    endQuantity: number;
    grossReturnBps: number;
    netReturnBps: number;
    limitingCapacity: {
        requestedStartQuantity: number;
        executableStartQuantity: number;
        utilizationPct: number;
    };
    legs: [TriangularLeg, TriangularLeg, TriangularLeg];
    timestamps: {
        evaluatedAt: number;
        quoteAgeMs: number;
        legSkewMs: number;
        exchangeTimestampsVerified: boolean;
    };
    riskFlags: string[];
}
export interface TriangularScan {
    updatedAt: number;
    venue: BasisVenue;
    startAsset: string;
    requestedStartQuantity: number;
    scannedMarkets: number;
    scannedCycles: number;
    totalOpportunities: number;
    truncated: boolean;
    marketDataMode: "rest-top-book";
    snapshotSource: "rest-snapshot";
    executionStatus: "non-executable-candidate";
    sequenceVerified: false;
    opportunities: TriangularOpportunity[];
}
export type PairwiseMarketType = "spot" | "perpetual" | "future";
export type PairwiseSide = "buy" | "sell";
export type PairwiseQuantityUnit = "base" | "quote" | "contract";
export type PairwiseBookSource = "websocket" | "rest" | "fixture";
export type PairwiseStrategyKind = "spot-spot" | "perpetual-perpetual" | "reverse-cash-and-carry" | "spot-dated-future" | "perpetual-future" | "calendar-spread" | "dated-futures-spread";
export type PairwiseQuantityModel = {
    unit: "base";
} | {
    unit: "quote";
} | {
    unit: "contract";
    contractMultiplier: number;
    multiplierAsset: "base" | "quote";
};
export interface PairwiseEconomicIdentityReview {
    status: "reviewed";
    source: string;
    version: string;
    asOf: number;
    validUntil: number;
}
export interface PairwiseInstrument {
    instrumentId: string;
    venue: string;
    symbol: string;
    marketType: PairwiseMarketType;
    baseAsset: string;
    economicAssetId: string;
    economicIdentity: PairwiseEconomicIdentityReview;
    quoteAsset: string;
    settleAsset: string;
    quantityModel: PairwiseQuantityModel;
    quantityStep: number;
    minimumQuantity: number;
    minimumNotional: number;
    takerFeeBps: number;
    expiryTime?: number;
}
export type PairwiseDepthLevel = readonly [price: number, nativeQuantity: number];
export interface PairwiseBookSnapshot {
    instrumentId: string;
    quantityUnit: PairwiseQuantityUnit;
    bids: readonly PairwiseDepthLevel[];
    asks: readonly PairwiseDepthLevel[];
    exchangeTs: number;
    receivedAt: number;
    complete: boolean;
    sequence?: number;
    source: PairwiseBookSource;
    sourceId: string;
}
export interface PairwiseInventoryAssumption {
    kind: "inventory";
    availableBaseQuantity: number;
    availabilityVerified: true;
    source: string;
    asOf: number;
}
export interface PairwiseCapitalAssumption {
    kind: "capital";
    availableQuoteQuantity: number;
    availabilityVerified: true;
    source: string;
    asOf: number;
}
export interface PairwiseBorrowAssumption {
    kind: "borrow";
    availableBaseQuantity: number;
    annualRateBps: number;
    availabilityVerified: true;
    coversUntil: number;
    source: string;
    asOf: number;
}
export interface PairwiseFundingAssumption {
    instrumentId: string;
    cumulativeRateBps: number;
    coversUntil: number;
    scheduleVerified: true;
    rateKind: "venue-estimate" | "manual-stress";
    source: string;
    asOf: number;
}
export interface PairwiseConvergenceAssumption {
    exitAt: number;
    expectedExitBasisBps: number;
    longExitFeeBps: number;
    shortExitFeeBps: number;
    source: string;
    asOf: number;
}
export interface PairwiseRebalanceAssumption {
    costBps: number;
    source: string;
    asOf: number;
}
export type PairwiseDeliveryAssumption = {
    mode: "close-before-expiry";
    exitAt: number;
    deliveryFeeBps: number;
    source: string;
    asOf: number;
} | {
    mode: "settle-near-roll-far";
    exitAt: number;
    nearInstrumentId: string;
    deliveryFeeBps: number;
    settlementPriceSource: string;
    source: string;
    asOf: number;
};
export interface PairwiseEvaluationOptions {
    evaluatedAt?: number;
    minNetReturnBps?: number;
    maxQuoteAgeMs?: number;
    maxLegSkewMs?: number;
    maxFutureClockSkewMs?: number;
    maxAssumptionAgeMs?: number;
    maxEconomicIdentityAgeMs?: number;
    maxResidualDeltaBps?: number;
    pairingIterations?: number;
}
export interface PairwiseEvaluationRequest {
    instruments: readonly [PairwiseInstrument, PairwiseInstrument];
    books: readonly [PairwiseBookSnapshot, PairwiseBookSnapshot];
    route: PairwiseRoute;
    options?: PairwiseEvaluationOptions;
}
export type PairwiseRiskFlag = "simultaneous-execution-not-guaranteed" | "caller-supplied-identity-review" | "prefunded-quote-capital" | "prefunded-spot-inventory" | "cross-venue-rebalance" | "explicit-borrow-assumption" | "funding-estimate" | "manual-funding-stress" | "convergence-assumption" | "delivery-assumption" | "derivative-margin-not-modeled" | "inverse-or-quote-valued-contract" | "depth-limited" | "capital-limited" | "inventory-limited" | "rounding-dust" | "residual-base-delta" | "near-minimum-notional" | "top-book-only" | "rest-snapshot";
export interface PairwiseLegSimulation {
    role: "long" | "short";
    instrumentId: string;
    venue: string;
    symbol: string;
    marketType: PairwiseMarketType;
    side: PairwiseSide;
    bookSide: "asks" | "bids";
    nativeQuantity: number;
    quantityUnit: PairwiseQuantityUnit;
    baseEquivalentQuantity: number;
    averagePrice: number;
    worstPrice: number;
    quoteNotional: number;
    entryFeeBps: number;
    entryFeeQuote: number;
    levelsUsed: number;
    depthLimited: boolean;
    exchangeTs: number;
    receivedAt: number;
}
export interface PairwiseCostBreakdown {
    entryFeesQuote: number;
    exitFeesQuote: number;
    borrowCostQuote: number;
    fundingNetQuote: number;
    deliveryFeesQuote: number;
    rebalanceCostQuote: number;
}
export interface PairwiseTimestamps {
    evaluatedAt: number;
    oldestExchangeTs: number;
    newestExchangeTs: number;
    oldestReceivedAt: number;
    newestReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
    oldestAssumptionAsOf: number;
    assumptionAgeMs: number;
    horizonExitAt?: number;
}
export interface PairwiseBookProvenance {
    instrumentId: string;
    source: PairwiseBookSource;
    sourceId: string;
    sequence?: number;
    exchangeTs: number;
    receivedAt: number;
}
export interface PairwiseProvenance {
    engine: "pairwise-v1";
    routeId: string;
    metadataIds: readonly [string, string];
    economicIdentity: {
        economicAssetId: string;
        matchPolicy: "exact";
        authority: "caller-supplied";
        maxAgeMs: number;
        maxFutureClockSkewMs: number;
        legs: readonly [PairwiseEconomicIdentityReview & {
            instrumentId: string;
            effectiveValidUntil: number;
        }, PairwiseEconomicIdentityReview & {
            instrumentId: string;
            effectiveValidUntil: number;
        }];
    };
    books: readonly [PairwiseBookProvenance, PairwiseBookProvenance];
    assumptions: readonly {
        kind: string;
        source: string;
        asOf: number;
    }[];
}
export interface PairwiseOpportunity {
    id: string;
    strategyKind: PairwiseStrategyKind;
    edgeKind: "research-simulation";
    executable: false;
    routeId: string;
    baseAsset: string;
    economicAssetId: string;
    quoteAsset: string;
    requestedBaseQuantity: number;
    executableBaseQuantity: number;
    longBaseQuantity: number;
    shortBaseQuantity: number;
    residualBaseQuantity: number;
    unfilledBaseQuantity: number;
    capacityShortfallBaseQuantity: number;
    baseDustQuantity: number;
    grossEntryPnlQuote: number;
    grossExpectedPnlQuote: number;
    netExpectedPnlQuote: number;
    entryBasisBps: number;
    expectedExitBasisBps: number;
    netReturnBps: number;
    referenceNotionalQuote: number;
    legs: readonly [PairwiseLegSimulation, PairwiseLegSimulation];
    costs: PairwiseCostBreakdown;
    timestamps: PairwiseTimestamps;
    provenance: PairwiseProvenance;
    riskFlags: readonly PairwiseRiskFlag[];
}
export type PairwiseRejectionCode = "unknown-instrument" | "economic-identity-invalid" | "economic-identity-mismatch" | "invalid-route" | "settlement-conversion-required" | "missing-book" | "invalid-book" | "incomplete-book" | "stale-book" | "skewed-books" | "missing-assumption" | "stale-assumption" | "capital-unavailable" | "borrow-unavailable" | "minimum-quantity" | "minimum-notional" | "insufficient-depth" | "residual-delta" | "expiry-boundary" | "non-profitable";
export interface PairwiseRejection {
    routeId?: string;
    instrumentId?: string;
    code: PairwiseRejectionCode;
    message: string;
}
interface PairwiseEvaluationEnvelope {
    engine: "pairwise-v1";
    executable: false;
    evaluatedAt: number;
}
export type PairwiseEvaluationResponse = PairwiseEvaluationEnvelope & ({
    opportunity: PairwiseOpportunity;
    rejection?: never;
} | {
    opportunity?: never;
    rejection: PairwiseRejection;
});
export type NativeSpreadContractType = "FundingRateArb" | "CarryTrade" | "FutureSpread" | "PerpBasis";
export type NativeSpreadLegType = "LinearPerpetual" | "LinearFutures" | "Spot";
export type NativeSpreadRiskFlag = "read-only" | "top-book-only" | "venue-native-combination" | "revalidate-before-order";
export interface NativeSpreadLeg {
    symbol: string;
    contractType: NativeSpreadLegType;
}
export interface NativeSpreadOpportunity {
    id: string;
    venue: "bybit";
    symbol: string;
    contractType: NativeSpreadContractType;
    status: "Trading";
    baseCoin: string;
    quoteCoin: string;
    settleCoin: string;
    tickSize: number;
    minimumPrice: number;
    maximumPrice: number;
    quantityStep: number;
    minimumQuantity: number;
    maximumQuantity: number;
    launchTime: number;
    deliveryTime?: number;
    legs: [NativeSpreadLeg, NativeSpreadLeg];
    bidPrice: number;
    bidQuantity: number;
    askPrice: number;
    askQuantity: number;
    bookWidth: number;
    relativeBookWidthBps?: number;
    executableQuantity: number;
    sequence: number;
    exchangeTs: number;
    matchingEngineTs: number;
    receivedAt: number;
    quoteAgeMs: number;
    riskFlags: NativeSpreadRiskFlag[];
}
export interface NativeSpreadScan {
    venue: "bybit";
    marketDataMode: "venue-native-spread-orderbook";
    executionModel: "venue-matched-multi-leg";
    readOnly: true;
    updatedAt: number;
    totalInstruments: number;
    eligibleInstruments: number;
    scannedInstruments: number;
    healthyBooks: number;
    totalOpportunities: number;
    truncated: boolean;
    candidateTruncated: boolean;
    sourceErrors: string[];
    opportunities: NativeSpreadOpportunity[];
}
export interface InstrumentRegistryResponse {
    updatedAt: number;
    checkedAt: number;
    stale: boolean;
    includeStale: boolean;
    total: number;
    truncated: boolean;
    instruments: RegistryInstrument[];
    sourceErrors: string[];
    sourceStates: InstrumentRegistrySourceState[];
}
export interface VenueCapabilitiesResponse {
    updatedAt: number;
    checkedAt: number;
    stale: boolean;
    capabilities: VenueCapabilityManifest[];
    sourceErrors: string[];
    sourceStates: InstrumentRegistrySourceState[];
}
export interface InstrumentRegistrySourceState {
    source: string;
    status: "fresh" | "stale-cache" | "quarantined";
    receivedAt?: number;
    checkedAt: number;
    ageMs?: number;
    message?: string;
}
export interface PublicAdapterValidationIssue {
    index: number;
    instrumentId?: string;
    message: string;
}
export interface PublicVenueInstrumentResponse {
    readOnly: true;
    venue: string;
    marketType: VenueMarketType;
    receivedAt: number;
    total: number;
    truncated: boolean;
    instruments: RegistryInstrument[];
    rejectedRows: PublicAdapterValidationIssue[];
}
export interface PublicVenueTopBook {
    readOnly?: true;
    venue: string;
    instrumentId: string;
    marketType: VenueMarketType;
    quantityUnit: VenueQuantityUnit;
    bid: number;
    bidSize: number;
    ask: number;
    askSize: number;
    last?: number;
    lastSize?: number;
    volume24h?: number;
    volumeCurrency24h?: number;
    source?: string;
    executable?: boolean;
    sequenceAvailable?: boolean;
    exchangeTs: number;
    receivedAt: number;
}
export interface PublicVenueTickerResponse {
    readOnly: true;
    venue: string;
    marketType: VenueMarketType;
    receivedAt: number;
    total: number;
    truncated: boolean;
    tickers: PublicVenueTopBook[];
    rejectedRows: PublicAdapterValidationIssue[];
}
export interface PublicVenueDepthResponse {
    readOnly: true;
    venue: string;
    instrumentId: string;
    marketType: VenueMarketType;
    quantityUnit: VenueQuantityUnit;
    bids: ReadonlyArray<readonly [number, number, number?]>;
    asks: ReadonlyArray<readonly [number, number, number?]>;
    sequence: number;
    sequenceVerified?: boolean;
    source?: string;
    exchangeTs: number;
    receivedAt: number;
    complete: true;
}
export interface PublicVenueFundingPoint {
    instrumentId: string;
    fundingTime: number;
    fundingRate: number;
    realizedRate?: number;
    formulaType?: string;
    method?: string;
}
export interface PublicVenueFundingResponse {
    readOnly: true;
    venue: string;
    marketType: VenueFundingMarketType;
    instrumentId: string;
    currentEstimateRate: number;
    fundingTime: number;
    nextFundingTime: number;
    intervalMinutes?: number;
    scheduleVerified: boolean;
    nextEstimateRate?: number;
    settledRate?: number;
    minimumRate?: number;
    maximumRate?: number;
    formulaType?: string;
    method?: string;
    network?: "mainnet" | "testnet";
    currentEstimateSource?: string;
    timestampSource?: "exchange" | "local-receive";
    exchangeTs: number;
    receivedAt: number;
    history: PublicVenueFundingPoint[];
    sourceErrors: string[];
}
