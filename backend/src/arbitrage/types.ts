export type ArbitrageExchange = "binance" | "bybit";
export type ArbitrageMarket = "spot" | "perpetual";

export interface ArbitrageVenueQuote {
  instrumentId?: string;
  economicAssetId?: string;
  registryIdentity?: ArbitrageRegistryIdentity;
  symbol: string;
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  fundingRate?: number;
  nextFundingTime?: number;
  fundingIntervalMinutes?: number;
  fundingScheduleVerified?: boolean;
  /** Venue-provided timestamp. Omitted when the endpoint does not publish one. */
  exchangeTs?: number;
  /** True only when exchangeTs came from the venue, never from local receipt time. */
  exchangeTimestampVerified: boolean;
  receivedAt: number;
}

/** Sanitized registry proof attached to both legs from one registry snapshot. */
export interface ArbitrageRegistryIdentity {
  nativeAssetId: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
}

export interface ArbitrageOpportunity {
  id: string;
  strategyKind: "cash-and-carry";
  edgeKind: "projected";
  /** Native identity is venue-local; reviewed identity is safe across venues. */
  identityScope: "venue-native" | "cross-venue-reviewed";
  symbol: string;
  assetId: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
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
  nextFundingTime?: number;
  fundingIntervalMinutes?: number;
  fundingScheduleVerified: boolean;
  spotExchangeTs?: number;
  spotExchangeTimestampVerified: boolean;
  spotReceivedAt: number;
  futuresExchangeTs?: number;
  futuresExchangeTimestampVerified: boolean;
  futuresReceivedAt: number;
  quoteAgeMs: number;
  legSkewMs: number;
  dataQuality: "fresh" | "stale" | "skewed" | "unverified";
  /** Present when raw venue timestamps were evaluated through venue-clock-v1. */
  clockCorrection?: ArbitrageOpportunityClockCorrection;
  capturedAt: number;
}

export interface ArbitrageOpportunityClockLeg {
  sourceId: string;
  clockStatus: "calibrated" | "degraded" | "expired" | "unavailable";
  eligible: boolean;
  quality: "verified" | "degraded" | "unavailable";
  offsetLowerMs?: number;
  offsetUpperMs?: number;
  ageLowerMs?: number;
  ageUpperMs?: number;
  reason?: "clock-unavailable" | "clock-not-calibrated" | "timestamp-definitely-future" | "timestamp-may-be-future" | "timestamp-stale";
}

export interface ArbitrageOpportunityClockCorrection {
  modelVersion: "venue-clock-v1";
  spot: ArbitrageOpportunityClockLeg;
  futures: ArbitrageOpportunityClockLeg;
  skewEligible: boolean;
  minimumPossibleSkewMs?: number;
  maximumPossibleSkewMs?: number;
  skewReason?: "clock-unavailable" | "clock-not-calibrated" | "skew-exceeded";
}

export interface ArbitrageDepthLeg {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  quantity: number;
  averagePrice: number;
  worstPrice: number;
  topPrice: number;
  slippageBps: number;
  levelsUsed: number;
  complete: boolean;
  capturedAt: number;
}

export interface ArbitrageDepthBookTiming {
  /** Venue-provided timestamp. Omitted when the REST endpoint does not publish one. */
  exchangeTs?: number;
  /** Local time at which this exact book payload finished decoding. */
  receivedAt: number;
  /** Age of this exact book at response evaluation time. */
  ageMs: number;
  /** Venue update/sequence identifier when the REST snapshot publishes one. */
  sequence?: number;
  /** Snapshot/delta continuity, not merely presence of a REST update id. */
  sequenceVerified: boolean;
  source: "rest-snapshot" | "websocket-reconstructed";
}

export interface ArbitrageDepthTiming {
  spot: ArbitrageDepthBookTiming;
  perpetual: ArbitrageDepthBookTiming;
  /** Oldest local receive timestamp expressed as an age at evaluation time. */
  ageMs: number;
  receiveSkewMs: number;
  /** Available only when both venues supplied exchange timestamps. */
  exchangeSkewMs?: number;
  /** Receive skew, additionally bounded by exchange skew when both are available. */
  legSkewMs: number;
  exchangeTimestampsVerified: boolean;
  /** True only when both legs were reconstructed without a detected sequence gap. */
  sequenceContinuityVerified: boolean;
  quality: "fresh" | "stale" | "skewed" | "unverified";
}

export interface ArbitrageDepthConstraints {
  /** Both registry records supplied coherent status, identity, unit and settlement metadata. */
  metadataVerified: boolean;
  /** The matched result satisfies both venues' published quantity and notional minimums. */
  minimumsSatisfied: boolean;
  verified: boolean;
  failures: string[];
}

export interface ArbitrageDepthResponse {
  identityScope: "venue-native" | "cross-venue-reviewed";
  assetId: string;
  economicAssetId?: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
  symbol: string;
  direction: "entry" | "exit";
  requestedNotionalUsd: number;
  /** Base quantity implied by the requested spot USD budget before lot rounding. */
  targetQuantity: number;
  /** One executable base quantity shared by the long spot and short perpetual legs. */
  matchedQuantity: number;
  /** Common increment executable on both venues. */
  quantityStep: number;
  quantityStepSource: "instrument" | "fallback";
  /** False until both venue-specific lot steps were supplied by instrument metadata. */
  precisionVerified: boolean;
  roundingDustQuantity: number;
  liquidityShortfallQuantity: number;
  /** Long spot quantity minus short perpetual quantity. */
  residualDeltaQuantity: number;
  spot: ArbitrageDepthLeg;
  perpetual: ArbitrageDepthLeg;
  timing: ArbitrageDepthTiming;
  constraints: ArbitrageDepthConstraints;
  grossSpreadBps: number;
  complete: boolean;
  capturedAt: number;
}

export interface ArbitrageSourceStatus {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  ok: boolean;
  message?: string;
}

/** Completeness proof for the instrument identities used to enumerate basis routes. */
export interface ArbitrageIdentityCoverage {
  complete: boolean;
  stale: boolean;
  failedSources: string[];
}

export interface ArbitrageScanResponse {
  updatedAt: number;
  stale: boolean;
  scannedSymbols: number;
  totalOpportunities: number;
  truncated: boolean;
  estimatedTotalCostBps: number;
  opportunities: ArbitrageOpportunity[];
  sources: ArbitrageSourceStatus[];
  identityCoverage?: ArbitrageIdentityCoverage;
}
