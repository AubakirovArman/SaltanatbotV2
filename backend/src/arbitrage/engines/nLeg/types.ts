export const N_LEG_MIN_LEGS = 4;
export const N_LEG_SAFE_MAX_LEGS = 8;
export const N_LEG_SAFE_MAX_CYCLES = 20_000;
export const N_LEG_SAFE_MAX_TRAVERSAL_STEPS = 2_000_000;
export const N_LEG_SAFE_MAX_MARKETS = 20_000;
export const N_LEG_SAFE_MAX_BOOK_LEVELS_PER_SIDE = 5_000;
export const N_LEG_SAFE_MAX_DEPTH_WALK_STEPS = 1_000_000;

/**
 * Exact accounting identity. Display tickers are deliberately insufficient:
 * two quantities connect only when venue, canonical asset and native unit all
 * match byte-for-byte after normalization.
 */
export interface NLegAssetUnit {
  venue: string;
  assetId: string;
  unitId: string;
}

export interface NLegFeeSchedule {
  scheduleId: string;
  tierId: string;
  takerBps: number;
  /** The exact asset/unit debited by this side of the conversion. */
  asset: NLegAssetUnit;
}

/** Spot-only instrument metadata used by the conserved-quantity engine. */
export interface NLegMarketMetadata {
  instrumentId: string;
  venue: string;
  symbol: string;
  marketType: "spot";
  base: NLegAssetUnit;
  quote: NLegAssetUnit;
  /** Base-asset quantity increment. */
  quantityStep: number;
  /** Minimum order quantity in the exact base unit. */
  minimumQuantity: number;
  /** Minimum pre-fee quote notional in the exact quote unit. */
  minimumNotional: number;
  buyFee: NLegFeeSchedule;
  sellFee: NLegFeeSchedule;
}

export type NLegSide = "buy" | "sell";
export type NLegFeeDebit = "input" | "output";

export interface NLegConversionEdge {
  edgeId: string;
  instrumentId: string;
  venue: string;
  symbol: string;
  side: NLegSide;
  from: NLegAssetUnit;
  to: NLegAssetUnit;
  fromKey: string;
  toKey: string;
  fee: NLegFeeSchedule;
  feeDebit: NLegFeeDebit;
}

export interface NLegCycle {
  cycleId: string;
  canonicalSignature: string;
  venue: string;
  start: NLegAssetUnit;
  startKey: string;
  /** Always between N_LEG_MIN_LEGS and the configured safe maximum. */
  edges: readonly NLegConversionEdge[];
}

export interface NLegMetadataRejection {
  instrumentId: string;
  code: "invalid-metadata" | "duplicate-instrument" | "fee-conservation";
  message: string;
}

export type NLegGraphTruncationReason = "cycle-limit" | "traversal-work-limit";

export interface NLegGraphWork {
  marketCount: number;
  maxMarkets: number;
  traversalSteps: number;
  maxTraversalSteps: number;
  maxCycles: number;
  truncated: boolean;
  truncationReason?: NLegGraphTruncationReason;
}

export interface NLegGraph {
  markets: ReadonlyMap<string, NLegMarketMetadata>;
  cycles: readonly NLegCycle[];
  cyclesByInstrument: ReadonlyMap<string, readonly NLegCycle[]>;
  metadataRejections: readonly NLegMetadataRejection[];
  work: NLegGraphWork;
}

export interface NLegGraphOptions {
  startAssets: readonly NLegAssetUnit[];
  minLegs?: number;
  maxLegs?: number;
  maxCycles?: number;
  maxTraversalSteps?: number;
  maxMarkets?: number;
  signal?: AbortSignal;
}

export type NLegDepthLevel = readonly [price: number, baseQuantity: number];

export interface NLegBookSnapshot {
  instrumentId: string;
  /** Unit provenance is repeated on the book to prevent adapter mix-ups. */
  base: NLegAssetUnit;
  quote: NLegAssetUnit;
  bids: readonly NLegDepthLevel[];
  asks: readonly NLegDepthLevel[];
  exchangeTs: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
  complete: boolean;
  sequence: number;
  sequenceVerified: boolean;
  sourceId: string;
}

export type NLegRejectionCode =
  | "missing-market"
  | "missing-book"
  | "identity-mismatch"
  | "invalid-book"
  | "incomplete-book"
  | "unsequenced-book"
  | "stale-book"
  | "skewed-books"
  | "fee-conservation"
  | "minimum-quantity"
  | "minimum-notional"
  | "insufficient-depth"
  | "work-limit"
  | "non-profitable";

export interface NLegRejection {
  cycleId: string;
  code: NLegRejectionCode;
  message: string;
  legIndex?: number;
  instrumentId?: string;
}

export interface NLegLegSimulation {
  index: number;
  instrumentId: string;
  venue: string;
  symbol: string;
  side: NLegSide;
  from: NLegAssetUnit;
  to: NLegAssetUnit;
  fromKey: string;
  toKey: string;
  inputQuantity: number;
  /** Trade debit before an input-side fee. */
  tradeInputQuantity: number;
  /** Trade debit plus an input-side fee; never exceeds inputQuantity. */
  totalInputDebitedQuantity: number;
  inputDustQuantity: number;
  orderBaseQuantity: number;
  averagePrice: number;
  worstPrice: number;
  quoteNotional: number;
  grossOutputQuantity: number;
  feeScheduleId: string;
  feeTierId: string;
  feeBps: number;
  feeAsset: NLegAssetUnit;
  feeAssetKey: string;
  feeDebit: NLegFeeDebit;
  feeQuantity: number;
  outputQuantity: number;
  levelsUsed: number;
  exchangeTs: number;
  receivedAt: number;
  sequence: number;
}

export interface NLegResidual {
  legIndex: number;
  asset: NLegAssetUnit;
  assetKey: string;
  quantity: number;
  reason: "lot-rounding";
}

export interface NLegOpportunityTimestamps {
  evaluatedAt: number;
  oldestExchangeTs: number;
  newestExchangeTs: number;
  oldestReceivedAt: number;
  newestReceivedAt: number;
  quoteAgeMs: number;
  legSkewMs: number;
  sequenceVerified: true;
  exchangeTimestampsVerified: true;
}

export interface NLegOpportunity {
  id: string;
  strategyKind: "n-leg-cycle";
  edgeKind: "research-simulation";
  executable: false;
  executionModel: "sequential-visible-depth";
  cycleId: string;
  venue: string;
  legCount: number;
  start: NLegAssetUnit;
  startKey: string;
  requestedStartQuantity: number;
  startQuantity: number;
  endQuantity: number;
  netReturnBps: number;
  capacityUtilizationPct: number;
  depthLimited: boolean;
  limitingLegIndex?: number;
  limitingInstrumentId?: string;
  legs: readonly NLegLegSimulation[];
  residuals: readonly NLegResidual[];
  dustByAssetUnit: Readonly<Record<string, number>>;
  feesByAssetUnit: Readonly<Record<string, number>>;
  timestamps: NLegOpportunityTimestamps;
  provenance: {
    engine: "n-leg-v1";
    canonicalSignature: string;
    instrumentIds: readonly string[];
    feeScheduleIds: readonly string[];
    bookSourceIds: readonly string[];
  };
}

export interface NLegEvaluationLimits {
  minNetReturnBps?: number;
  maxQuoteAgeMs?: number;
  maxLegSkewMs?: number;
  maxFutureClockSkewMs?: number;
  depthSearchIterations?: number;
  maxBookLevelsPerSide?: number;
  maxDepthWalkSteps?: number;
}

export interface NLegEvaluationRequest {
  cycle: NLegCycle;
  markets: ReadonlyMap<string, NLegMarketMetadata>;
  books: ReadonlyMap<string, NLegBookSnapshot>;
  requestedStartQuantity: number;
  evaluatedAt: number;
  limits?: NLegEvaluationLimits;
  signal?: AbortSignal;
}

export type NLegEvaluationResult = { opportunity: NLegOpportunity; rejection?: never } | { opportunity?: never; rejection: NLegRejection };
