export type TriangularSide = "buy" | "sell";

export type TriangularRiskFlag =
  | "sequential-leg-risk"
  | "output-fee-assumption"
  | "rounding-dust"
  | "depth-limited"
  | "near-minimum-notional"
  | "top-book-only"
  | "rest-snapshot"
  | "unsequenced"
  | "unverified-exchange-time"
  | "non-executable-candidate";

export type TriangularRejectionCode = "unknown-market" | "invalid-book" | "incomplete-book" | "missing-book" | "stale-book" | "skewed-books" | "minimum-quantity" | "minimum-notional" | "insufficient-depth" | "non-profitable";

/**
 * Metadata required to make an executable spot conversion. Every numeric field
 * is mandatory on purpose: markets with incomplete venue metadata are omitted
 * from the graph instead of being evaluated with optimistic defaults.
 */
export interface TriangularMarketMetadata {
  marketId: string;
  venue: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  takerFeeBps: number;
}

export type TriangularDepthLevel = readonly [price: number, baseQuantity: number];

export interface TriangularBookUpdate {
  marketId: string;
  bids: readonly TriangularDepthLevel[];
  asks: readonly TriangularDepthLevel[];
  /** Venue-provided timestamp; absent when the source payload has none. */
  exchangeTs?: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
  /** True when all levels promised by this source payload are present. */
  complete: boolean;
  sequence?: number;
  /** True only after snapshot/delta sequence bridging or equivalent verification. */
  sequenceVerified: boolean;
}

export interface TriangularConversionEdge {
  edgeId: string;
  marketId: string;
  venue: string;
  symbol: string;
  fromAsset: string;
  toAsset: string;
  side: TriangularSide;
}

export interface TriangularCycle {
  cycleId: string;
  venue: string;
  startAsset: string;
  edges: readonly [TriangularConversionEdge, TriangularConversionEdge, TriangularConversionEdge];
}

export interface TriangularLegExecution {
  index: 0 | 1 | 2;
  marketId: string;
  symbol: string;
  side: TriangularSide;
  fromAsset: string;
  toAsset: string;
  inputQuantity: number;
  inputConsumedQuantity: number;
  inputDustQuantity: number;
  orderBaseQuantity: number;
  averagePrice: number;
  worstPrice: number;
  quoteNotional: number;
  grossOutputQuantity: number;
  feeBps: number;
  feeQuantity: number;
  feeAsset: string;
  outputQuantity: number;
  levelsUsed: number;
  exchangeTs?: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
}

export interface TriangularCapacity {
  requestedStartQuantity: number;
  executableStartQuantity: number;
  utilizationPct: number;
  limitingLegIndex?: 0 | 1 | 2;
  limitingMarketId?: string;
}

export interface TriangularOpportunityTimestamps {
  evaluatedAt: number;
  oldestExchangeTs?: number;
  newestExchangeTs?: number;
  oldestReceivedAt: number;
  newestReceivedAt: number;
  quoteAgeMs: number;
  legSkewMs: number;
  exchangeTimestampsVerified: boolean;
}

export interface TriangularOpportunity {
  id: string;
  strategyKind: "triangular";
  edgeKind: "executable-sequential" | "non-executable-candidate";
  executionStatus: "executable" | "non-executable-candidate";
  marketDataMode: "sequence-verified-depth" | "rest-top-book";
  sequenceVerified: boolean;
  venue: string;
  cycleId: string;
  startAsset: string;
  endAsset: string;
  requestedStartQuantity: number;
  startQuantity: number;
  grossEndQuantity: number;
  endQuantity: number;
  grossReturnBps: number;
  netReturnBps: number;
  limitingCapacity: TriangularCapacity;
  legs: readonly [TriangularLegExecution, TriangularLegExecution, TriangularLegExecution];
  dustByAsset: Readonly<Record<string, number>>;
  timestamps: TriangularOpportunityTimestamps;
  riskFlags: readonly TriangularRiskFlag[];
}

export interface TriangularRejection {
  cycleId?: string;
  code: TriangularRejectionCode;
  message: string;
  legIndex?: 0 | 1 | 2;
  marketId?: string;
}

export interface TriangularEngineOptions {
  /** Requested scan size in native units of every supported cycle anchor. */
  startQuantities: Readonly<Record<string, number>>;
  minNetReturnBps?: number;
  maxQuoteAgeMs?: number;
  maxLegSkewMs?: number;
  maxFutureClockSkewMs?: number;
  now?: () => number;
  depthSearchIterations?: number;
  /** REST top-book mode produces research candidates and can never be executable. */
  marketDataMode?: "sequence-verified-depth" | "rest-top-book-candidate";
}

export interface TriangularUpdateResult {
  marketId: string;
  evaluatedCycleIds: string[];
  upserted: TriangularOpportunity[];
  removedOpportunityIds: string[];
  rejections: TriangularRejection[];
}

export interface TriangularMetadataRejection {
  marketId: string;
  message: string;
}
