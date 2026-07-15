export type PairwiseMarketType = "spot" | "perpetual" | "future";
export type PairwiseSide = "buy" | "sell";
export type PairwiseQuantityUnit = "base" | "quote" | "contract";

export type PairwiseQuantityModel = { unit: "base" } | { unit: "quote" } | { unit: "contract"; contractMultiplier: number; multiplierAsset: "base" | "quote" };

/** Caller-supplied review metadata for the canonical economic asset identity. */
export interface PairwiseEconomicIdentityReview {
  status: "reviewed";
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
}

/** Complete public metadata required for native-to-base quantity conversion. */
export interface PairwiseInstrument {
  instrumentId: string;
  venue: string;
  symbol: string;
  marketType: PairwiseMarketType;
  baseAsset: string;
  /** Canonical underlying identity. Display tickers are never identity proof. */
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
  source: "websocket" | "rest" | "fixture";
  sourceId: string;
}

interface TimestampedAssumption {
  source: string;
  asOf: number;
}

export interface PairwiseInventoryAssumption extends TimestampedAssumption {
  kind: "inventory";
  availableBaseQuantity: number;
  availabilityVerified: true;
}

/** Verified quote balance reserved for a spot buy leg. It is research input, not account state. */
export interface PairwiseCapitalAssumption extends TimestampedAssumption {
  kind: "capital";
  availableQuoteQuantity: number;
  availabilityVerified: true;
}

export interface PairwiseBorrowAssumption extends TimestampedAssumption {
  kind: "borrow";
  availableBaseQuantity: number;
  annualRateBps: number;
  availabilityVerified: true;
  coversUntil: number;
}

export interface PairwiseFundingAssumption extends TimestampedAssumption {
  instrumentId: string;
  /** Aggregate rate over the full holding horizon. Positive means longs pay shorts. */
  cumulativeRateBps: number;
  coversUntil: number;
  scheduleVerified: true;
  rateKind: "venue-estimate" | "manual-stress";
}

export interface PairwiseConvergenceAssumption extends TimestampedAssumption {
  /** Absolute close/valuation time; it must still be in the future at evaluation. */
  exitAt: number;
  /** Expected (short price - long price) / reference price at exit. */
  expectedExitBasisBps: number;
  longExitFeeBps: number;
  shortExitFeeBps: number;
}

export interface PairwiseRebalanceAssumption extends TimestampedAssumption {
  /** Explicit transfer/inventory-rebalancing cost on matched quote notional. */
  costBps: number;
}

export type PairwiseDeliveryAssumption =
  | (TimestampedAssumption & {
      mode: "close-before-expiry";
      exitAt: number;
      deliveryFeeBps: number;
    })
  | (TimestampedAssumption & {
      mode: "settle-near-roll-far";
      exitAt: number;
      nearInstrumentId: string;
      deliveryFeeBps: number;
      settlementPriceSource: string;
    });

interface PairwiseRouteBase {
  routeId: string;
  longInstrumentId: string;
  shortInstrumentId: string;
  requestedBaseQuantity: number;
}

export interface SpotSpotRoute extends PairwiseRouteBase {
  strategyKind: "spot-spot";
  longCapital: PairwiseCapitalAssumption;
  shortAccess: PairwiseInventoryAssumption;
  rebalance: PairwiseRebalanceAssumption;
}

export interface PerpetualPerpetualRoute extends PairwiseRouteBase {
  strategyKind: "perpetual-perpetual";
  convergence: PairwiseConvergenceAssumption;
  funding: readonly PairwiseFundingAssumption[];
}

export interface ReverseCashAndCarryRoute extends PairwiseRouteBase {
  strategyKind: "reverse-cash-and-carry";
  convergence: PairwiseConvergenceAssumption;
  borrow: PairwiseBorrowAssumption;
  funding: readonly PairwiseFundingAssumption[];
}

export interface SpotDatedFutureRoute extends PairwiseRouteBase {
  strategyKind: "spot-dated-future";
  longCapital: PairwiseCapitalAssumption;
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export interface PerpetualFutureRoute extends PairwiseRouteBase {
  strategyKind: "perpetual-future";
  convergence: PairwiseConvergenceAssumption;
  funding: readonly [PairwiseFundingAssumption];
  delivery: PairwiseDeliveryAssumption;
}

export interface CalendarSpreadRoute extends PairwiseRouteBase {
  strategyKind: "calendar-spread";
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export interface DatedFuturesSpreadRoute extends PairwiseRouteBase {
  strategyKind: "dated-futures-spread";
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export type PairwiseRoute =
  | SpotSpotRoute
  | PerpetualPerpetualRoute
  | ReverseCashAndCarryRoute
  | SpotDatedFutureRoute
  | PerpetualFutureRoute
  | CalendarSpreadRoute
  | DatedFuturesSpreadRoute;

export type PairwiseRiskFlag =
  | "simultaneous-execution-not-guaranteed"
  | "caller-supplied-identity-review"
  | "prefunded-quote-capital"
  | "prefunded-spot-inventory"
  | "cross-venue-rebalance"
  | "explicit-borrow-assumption"
  | "funding-estimate"
  | "manual-funding-stress"
  | "convergence-assumption"
  | "delivery-assumption"
  | "derivative-margin-not-modeled"
  | "inverse-or-quote-valued-contract"
  | "depth-limited"
  | "capital-limited"
  | "inventory-limited"
  | "rounding-dust"
  | "residual-base-delta"
  | "near-minimum-notional"
  | "top-book-only"
  | "rest-snapshot";

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
    legs: readonly [PairwiseEconomicIdentityReview & { instrumentId: string; effectiveValidUntil: number }, PairwiseEconomicIdentityReview & { instrumentId: string; effectiveValidUntil: number }];
  };
  books: readonly [{ instrumentId: string; source: PairwiseBookSnapshot["source"]; sourceId: string; sequence?: number; exchangeTs: number; receivedAt: number }, { instrumentId: string; source: PairwiseBookSnapshot["source"]; sourceId: string; sequence?: number; exchangeTs: number; receivedAt: number }];
  assumptions: readonly { kind: string; source: string; asOf: number }[];
}

export interface PairwiseOpportunity {
  id: string;
  strategyKind: PairwiseRoute["strategyKind"];
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
  /** Step/contract pairing remainder after inventory and visible-depth caps. */
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

export type PairwiseRejectionCode =
  | "unknown-instrument"
  | "economic-identity-invalid"
  | "economic-identity-mismatch"
  | "invalid-route"
  | "settlement-conversion-required"
  | "missing-book"
  | "invalid-book"
  | "incomplete-book"
  | "stale-book"
  | "skewed-books"
  | "missing-assumption"
  | "stale-assumption"
  | "capital-unavailable"
  | "borrow-unavailable"
  | "minimum-quantity"
  | "minimum-notional"
  | "insufficient-depth"
  | "residual-delta"
  | "expiry-boundary"
  | "non-profitable";

export interface PairwiseRejection {
  routeId?: string;
  instrumentId?: string;
  code: PairwiseRejectionCode;
  message: string;
}

export interface PairwiseEvaluationOptions {
  evaluatedAt: number;
  minNetReturnBps: number;
  maxQuoteAgeMs: number;
  maxLegSkewMs: number;
  maxFutureClockSkewMs: number;
  maxAssumptionAgeMs: number;
  maxEconomicIdentityAgeMs: number;
  maxResidualDeltaBps: number;
  pairingIterations: number;
}

export interface PairwiseEngineOptions {
  minNetReturnBps?: number;
  maxQuoteAgeMs?: number;
  maxLegSkewMs?: number;
  maxFutureClockSkewMs?: number;
  maxAssumptionAgeMs?: number;
  maxEconomicIdentityAgeMs?: number;
  maxResidualDeltaBps?: number;
  pairingIterations?: number;
  now?: () => number;
}

export interface PairwiseUpdateResult {
  instrumentId: string;
  evaluatedRouteIds: string[];
  upserted: PairwiseOpportunity[];
  removedOpportunityIds: string[];
  rejections: PairwiseRejection[];
}
