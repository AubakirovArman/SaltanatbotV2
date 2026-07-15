export type OptionsParityDepthLevel = readonly [price: number, quantity: number];
export type OptionsParitySettlementProcess = "cash" | "future-then-immediate-cash";

export interface OptionsParityInstrument {
  instrumentId: string;
  venue: string;
  underlyingAsset: string;
  strikeAsset: string;
  settlementAsset: string;
  premiumAsset: string;
  expiryTime: number;
  strikePrice: number;
  optionType: "call" | "put";
  exerciseStyle: "european";
  automaticExercise: true;
  settlementProcess: OptionsParitySettlementProcess;
  quantityUnit: "base" | "contract";
  /** Base-asset amount represented by one native book unit. Must be 1 for base-unit books. */
  basePerQuantityUnit: number;
  quantityStep: number;
  minimumQuantity: number;
}

export interface OptionsParityUnderlyingInstrument {
  instrumentId: string;
  venue: string;
  baseAsset: string;
  quoteAsset: string;
  quantityUnit: "base" | "contract";
  basePerQuantityUnit: number;
  quantityStep: number;
  minimumQuantity: number;
}

export interface OptionsParityBook {
  instrumentId: string;
  bids: readonly OptionsParityDepthLevel[];
  asks: readonly OptionsParityDepthLevel[];
  exchangeTs: number;
  receivedAt: number;
  complete: boolean;
}

export interface OptionsParityOptionLegSnapshot {
  instrument: OptionsParityInstrument;
  book?: OptionsParityBook;
}

export interface OptionsParitySeriesSnapshot {
  seriesId: string;
  call?: OptionsParityOptionLegSnapshot;
  put?: OptionsParityOptionLegSnapshot;
}

export interface OptionsParityUnderlyingSnapshot {
  instrument: OptionsParityUnderlyingInstrument;
  book?: OptionsParityBook;
}

export interface SourcedAssumption {
  source: string;
  asOf: number;
}

export interface AnnualRateAssumption extends SourcedAssumption {
  /** Continuously compounded decimal annual rate, for example 0.05 for 5%. */
  annualRate: number;
}

export interface PremiumFxAssumption extends SourcedAssumption {
  fromAsset: string;
  toAsset: string;
  /** Units of toAsset per one unit of fromAsset. Identity conversions must explicitly use 1. */
  rate: number;
}

export type OptionsParityFeeModel =
  | { kind: "notional-bps"; bps: number }
  | { kind: "per-base-capped"; feePerBaseValuation: number; premiumCapFraction: number };

export interface OptionsParityFeeAssumption extends SourcedAssumption {
  model: OptionsParityFeeModel;
}

export interface ShortOptionCapacityAssumption extends SourcedAssumption {
  availabilityVerified: true;
  marginVerified: true;
  availableBaseQuantity: number;
}

export interface UnderlyingShortAssumption extends SourcedAssumption {
  borrowVerified: true;
  marginVerified: true;
  availableBaseQuantity: number;
  /** Continuously compounded decimal annual borrow rate. */
  annualBorrowRate: number;
}

export interface OptionsParitySettlementAssumption extends SourcedAssumption {
  exerciseStyle: "european";
  automaticExercise: true;
  holdToExpiry: true;
  economicSettlement: "cash";
  settlementPriceSource: string;
  acknowledgedProcesses: readonly OptionsParitySettlementProcess[];
}

export interface OptionsParityAssumptions {
  valuationAsset: string;
  riskFreeRate: AnnualRateAssumption;
  dividendYield: AnnualRateAssumption;
  settlement: OptionsParitySettlementAssumption;
  premiumFx: Record<string, PremiumFxAssumption | undefined>;
  optionFees: Record<string, OptionsParityFeeAssumption | undefined>;
  underlyingFee: OptionsParityFeeAssumption;
  shortOptionCapacity: Record<string, ShortOptionCapacityAssumption | undefined>;
  underlyingShort?: UnderlyingShortAssumption;
}

export interface OptionsParityEvaluationLimits {
  maxQuoteAgeMs?: number;
  maxLegSkewMs?: number;
  maxFutureClockSkewMs?: number;
  maxAssumptionAgeMs?: number;
  minimumNetEdgeValue?: number;
  pairingIterations?: number;
}

export interface OptionsParityEvaluationRequest {
  primary: OptionsParitySeriesSnapshot;
  secondary?: OptionsParitySeriesSnapshot;
  underlying: OptionsParityUnderlyingSnapshot;
  targetBaseQuantity: number;
  evaluatedAt: number;
  assumptions: OptionsParityAssumptions;
  limits?: OptionsParityEvaluationLimits;
}

export interface OptionsParityLegSimulation {
  role: "call" | "put" | "underlying";
  instrumentId: string;
  side: "buy" | "sell";
  bookSide: "asks" | "bids";
  nativeQuantity: number;
  baseQuantity: number;
  averagePrice: number;
  worstPrice: number;
  valuationCashAmount: number;
  feeValuation: number;
  levelsUsed: number;
  exchangeTs: number;
  receivedAt: number;
}

export type OptionsParityStrategyKind = "put-call-parity" | "conversion" | "reversal" | "box" | "synthetic-forward";

export interface OptionsParityCandidate {
  id: string;
  strategyKind: OptionsParityStrategyKind;
  direction: "call-rich" | "put-rich" | "long-box" | "short-box" | "long-synthetic" | "short-synthetic";
  edgeKind: "research-simulation";
  executable: false;
  simulationBasis: "visible-depth-taker";
  outcomeLabel:
    | "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
    | "parity-deviation-research-only-no-fixed-profit-without-hedge";
  underlyingAsset: string;
  valuationAsset: string;
  settlementAsset: string;
  expiryTime: number;
  strikes: number[];
  baseQuantity: number;
  grossEdgeValue: number;
  feesValue: number;
  borrowCostValue: number;
  netEdgeValue: number;
  edgeBpsOfReferenceNotional: number;
  referenceNotional: number;
  fixedPayoffAtExpiry?: number;
  theoreticalForwardPrice?: number;
  impliedForwardPrice?: number;
  legs: OptionsParityLegSimulation[];
  referenceUnderlying?: OptionsParityLegSimulation;
  timestamps: {
    evaluatedAt: number;
    oldestExchangeTs: number;
    newestExchangeTs: number;
    oldestReceivedAt: number;
    newestReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
    oldestAssumptionAsOf: number;
    assumptionAgeMs: number;
  };
  assumptionSources: string[];
}

export type OptionsParityRejectionCode =
  | "missing-leg"
  | "identity-mismatch"
  | "unsupported-exercise"
  | "settlement-mismatch"
  | "expired"
  | "invalid-book"
  | "incomplete-book"
  | "stale-book"
  | "skewed-books"
  | "missing-assumption"
  | "stale-assumption"
  | "insufficient-depth"
  | "step-mismatch"
  | "short-capacity";

export interface OptionsParityRejection {
  strategyKind?: OptionsParityStrategyKind;
  seriesId?: string;
  instrumentId?: string;
  code: OptionsParityRejectionCode;
  message: string;
}

export interface OptionsParityEvaluation {
  evaluatedAt: number;
  edgeKind: "research-simulation";
  executable: false;
  candidates: OptionsParityCandidate[];
  rejections: OptionsParityRejection[];
}

export interface OptionsParityEngineOptions {
  limits?: OptionsParityEvaluationLimits;
  now?: () => number;
}
