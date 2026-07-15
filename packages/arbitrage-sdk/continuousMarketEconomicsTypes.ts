export const CONTINUOUS_MARKET_ECONOMICS_ENGINE = "continuous-market-economics-v1" as const;
export const CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION = "continuous-public-taker-fee-v1" as const;

export type ContinuousMarketRouteFamily = "cross-venue-spot-spot" | "reverse-cash-and-carry" | "perpetual-perpetual-funding" | "spot-dated-future" | "calendar-spread" | "perpetual-future";

export const CONTINUOUS_MARKET_BLOCK_CODES = [
  "missing-instrument",
  "missing-top-book",
  "feed-not-live",
  "generation-mismatch",
  "invalid-top-book",
  "unverified-continuity",
  "stale-top-book",
  "future-top-book",
  "expiry-boundary",
  "skewed-top-books",
  "quantity-unit-mismatch",
  "unsupported-quantity-precision",
  "no-common-quantity",
  "minimum-quantity",
  "minimum-notional",
  "derived-arithmetic-invalid",
  "economic-identity-invalid",
  "economic-identity-not-yet-valid",
  "economic-identity-expired",
  "clock-unavailable",
  "clock-not-calibrated",
  "timestamp-definitely-future",
  "timestamp-may-be-future",
  "timestamp-stale",
  "clock-skew-exceeded",
  "account-capital-missing",
  "account-inventory-missing",
  "network-rebalance-missing",
  "borrow-evidence-missing",
  "funding-horizon-missing",
  "derivative-margin-missing",
  "convergence-evidence-missing",
  "expiry-delivery-evidence-missing"
] as const;

export type ContinuousMarketBlockCode = (typeof CONTINUOUS_MARKET_BLOCK_CODES)[number];

export interface ContinuousMarketBlockReason {
  code: ContinuousMarketBlockCode;
  stage: "market-data" | "strategy-evidence";
  subject?: string;
  message: string;
}

export interface ContinuousMarketFeePolicy {
  version: typeof CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION;
  source: "operator-environment";
  liquidity: "taker";
  discountsApplied: false;
  rebatesApplied: false;
  feeAssetVerified: false;
  exposureImpactIncluded: false;
  coverage: "entry-only";
}

export interface ContinuousMarketEconomicsSummary {
  engine: typeof CONTINUOUS_MARKET_ECONOMICS_ENGINE;
  readOnly: true;
  researchOnly: true;
  executable: false;
  outcomeClass: "projected";
  evaluatedAt: number;
  totalCandidates: number;
  evaluatedCandidates: number;
  marketOnlyCandidates: number;
  blockedCandidates: number;
  publishedEvaluations: number;
  publishedMarketOnlyCandidates: number;
  publishedBlockedCandidates: number;
  truncated: boolean;
  feePolicy: ContinuousMarketFeePolicy;
}

export interface ContinuousMarketLeg {
  role: "long" | "short";
  side: "buy" | "sell";
  instrumentId: string;
  venue: string;
  symbol: string;
  marketType: "spot" | "perpetual" | "future";
  quantityUnit: "base" | "quote" | "contract";
  price: number;
  topNativeQuantity: number;
  alignedNativeCapacity: number;
  usedNativeQuantity: number;
  baseQuantity: number;
  quoteNotional: number;
  takerFeeBps: number;
  publicEntryFeeQuoteEquivalentEstimate: number;
  feeAssumption: {
    policyVersion: typeof CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION;
    source: "operator-environment";
    accountTierVerified: false;
    discountsApplied: false;
    rebatesApplied: false;
    feeAssetVerified: false;
    exposureImpactIncluded: false;
  };
  bookEvidence: {
    sourceId: string;
    quality: "sequence-verified" | "checksum-verified";
    protocol: string;
    sequence: number;
    checksum?: number;
    connectionGeneration: number;
    exchangeTs: number;
    receivedAt: number;
  };
}

export interface ContinuousMarketEconomicIdentityEvidence {
  instrumentId: string;
  economicAssetId: string;
  status: "reviewed";
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
}

export interface ContinuousMarketCalibratedClockLeg {
  sourceId: string;
  exchangeTs: number;
  clockStatus: "calibrated";
  ageLowerMs: number;
  ageUpperMs: number;
  localEventEarliestAt: number;
  localEventLatestAt: number;
}

export interface ContinuousMarketEvaluationBase {
  engine: typeof CONTINUOUS_MARKET_ECONOMICS_ENGINE;
  readOnly: true;
  researchOnly: true;
  executable: false;
  outcomeClass: "projected";
  strategyStatus: "blocked";
  evaluatedAt: number;
  routeId: string;
  family: ContinuousMarketRouteFamily;
  longInstrumentId: string;
  shortInstrumentId: string;
  economicAssetId: string;
  baseAsset: string | null;
  quoteAsset: string | null;
  executionBoundary: {
    permission: false;
    orders: "not-supported";
    reason: "market-data-and-public-entry-fees-only";
  };
  blockedReasons: ContinuousMarketBlockReason[];
}

export interface ContinuousMarketOnlyEvaluation extends ContinuousMarketEvaluationBase {
  status: "market-only";
  baseAsset: string;
  quoteAsset: string;
  legs: readonly [ContinuousMarketLeg, ContinuousMarketLeg];
  capacity: {
    scope: "maximum-visible-top-book";
    matchedBaseQuantity: number;
    commonBaseQuantity: number;
    referenceNotionalQuote: number;
    longAlignedBaseCapacity: number;
    shortAlignedBaseCapacity: number;
  };
  edges: {
    grossEntryValueDifferenceQuote: number;
    grossEntryBasisBps: number;
    publicEntryFeesQuoteEquivalentEstimate: number;
    netEntryValueDifferenceAfterEstimatedFeesQuote: number;
    netEntryBasisAfterEstimatedFeesBps: number;
    coverage: "top-book-entry-and-public-taker-fees-only";
  };
  freshness: {
    status: "fresh";
    quoteAgeMs: number;
    legSkewMs: number;
    maxBookAgeMs: number;
    maxLegSkewMs: number;
    oldestReceivedAt: number;
    newestReceivedAt: number;
  } & (
    | {
        clockBasis: "calibrated-venue-interval";
        crossVenueComparable: true;
        quoteAgeLowerMs: number;
        quoteAgeUpperMs: number;
        minimumPossibleLegSkewMs: number;
        maximumPossibleLegSkewMs: number;
        clockLegs: readonly [ContinuousMarketCalibratedClockLeg, ContinuousMarketCalibratedClockLeg];
      }
    | {
        clockBasis: "local-receipt-fallback";
        crossVenueComparable: false;
        fallbackReason: "same-venue-clock-unavailable" | "same-venue-clock-not-calibrated" | "clock-provider-unavailable";
      }
  );
  evidence: {
    marketDataComplete: true;
    continuityVerified: true;
    requiredStrategyEvidenceComplete: false;
    sourceIds: readonly [string, string];
    economicIdentities: readonly [ContinuousMarketEconomicIdentityEvidence, ContinuousMarketEconomicIdentityEvidence];
  };
}

export interface ContinuousBlockedMarketEvaluation extends ContinuousMarketEvaluationBase {
  status: "blocked";
}

export type ContinuousMarketEvaluation = ContinuousMarketOnlyEvaluation | ContinuousBlockedMarketEvaluation;
