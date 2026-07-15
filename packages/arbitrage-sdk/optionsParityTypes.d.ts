export type OptionsParitySettlementProcess = "cash" | "future-then-immediate-cash";
export type OptionsParityDepthLevel = readonly [price: number, quantity: number];
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
    complete: true;
}
export interface OptionsParitySeriesInput {
    seriesId: string;
    call: {
        instrument: OptionsParityInstrument;
        book: OptionsParityBook;
    };
    put: {
        instrument: OptionsParityInstrument;
        book: OptionsParityBook;
    };
}
export interface OptionsParityUnderlyingInput {
    instrument: OptionsParityUnderlyingInstrument;
    book: OptionsParityBook;
}
export interface OptionsParitySourcedAssumption {
    source: string;
    asOf: number;
}
export interface OptionsParityAnnualRateAssumption extends OptionsParitySourcedAssumption {
    annualRate: number;
}
export interface OptionsParityPremiumFxAssumption extends OptionsParitySourcedAssumption {
    fromAsset: string;
    toAsset: string;
    rate: number;
}
export type OptionsParityFeeModel = {
    kind: "notional-bps";
    bps: number;
} | {
    kind: "per-base-capped";
    feePerBaseValuation: number;
    premiumCapFraction: number;
};
export interface OptionsParityFeeAssumption extends OptionsParitySourcedAssumption {
    model: OptionsParityFeeModel;
}
export interface OptionsParityShortCapacityAssumption extends OptionsParitySourcedAssumption {
    availabilityVerified: true;
    marginVerified: true;
    availableBaseQuantity: number;
}
export interface OptionsParityUnderlyingShortAssumption extends OptionsParitySourcedAssumption {
    borrowVerified: true;
    marginVerified: true;
    availableBaseQuantity: number;
    annualBorrowRate: number;
}
export interface OptionsParitySettlementAssumption extends OptionsParitySourcedAssumption {
    exerciseStyle: "european";
    automaticExercise: true;
    holdToExpiry: true;
    economicSettlement: "cash";
    settlementPriceSource: string;
    acknowledgedProcesses: readonly OptionsParitySettlementProcess[];
}
export interface OptionsParityAssumptions {
    valuationAsset: string;
    riskFreeRate: OptionsParityAnnualRateAssumption;
    dividendYield: OptionsParityAnnualRateAssumption;
    settlement: OptionsParitySettlementAssumption;
    premiumFx: Record<string, OptionsParityPremiumFxAssumption>;
    optionFees: Record<string, OptionsParityFeeAssumption>;
    underlyingFee: OptionsParityFeeAssumption;
    shortOptionCapacity: Record<string, OptionsParityShortCapacityAssumption>;
    underlyingShort?: OptionsParityUnderlyingShortAssumption;
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
    primary: OptionsParitySeriesInput;
    secondary?: OptionsParitySeriesInput;
    underlying: OptionsParityUnderlyingInput;
    targetBaseQuantity: number;
    evaluatedAt?: number;
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
export type OptionsParityDirection = "call-rich" | "put-rich" | "long-box" | "short-box" | "long-synthetic" | "short-synthetic";
export interface OptionsParityTimestamps {
    evaluatedAt: number;
    oldestExchangeTs: number;
    newestExchangeTs: number;
    oldestReceivedAt: number;
    newestReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
    oldestAssumptionAsOf: number;
    assumptionAgeMs: number;
}
export interface OptionsParityCandidate {
    id: string;
    strategyKind: OptionsParityStrategyKind;
    direction: OptionsParityDirection;
    edgeKind: "research-simulation";
    executable: false;
    simulationBasis: "visible-depth-taker";
    outcomeLabel: "fixed-valuation-payoff-at-expiry-under-stated-assumptions" | "parity-deviation-research-only-no-fixed-profit-without-hedge";
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
    timestamps: OptionsParityTimestamps;
    assumptionSources: string[];
}
export type OptionsParityRejectionCode = "missing-leg" | "identity-mismatch" | "unsupported-exercise" | "settlement-mismatch" | "expired" | "invalid-book" | "incomplete-book" | "stale-book" | "skewed-books" | "missing-assumption" | "stale-assumption" | "insufficient-depth" | "step-mismatch" | "short-capacity";
export interface OptionsParityRejection {
    strategyKind?: OptionsParityStrategyKind;
    seriesId?: string;
    instrumentId?: string;
    code: OptionsParityRejectionCode;
    message: string;
}
export interface OptionsParityAssumptionContract {
    authority: "caller-supplied";
    expiry: "explicit-instrument-timestamp";
    settlement: "european-automatic-hold-to-expiry-cash-equivalent";
    settlementFx: "unsupported-settlement-must-equal-valuation-asset";
    premiumFx: "explicit-per-premium-asset";
    fees: "explicit-per-option-and-underlying";
    execution: "none";
}
export interface OptionsParityEvaluationResponse {
    engine: "options-parity-v1";
    readOnly: true;
    researchOnly: true;
    executable: false;
    evaluatedAt: number;
    edgeKind: "research-simulation";
    assumptionContract: OptionsParityAssumptionContract;
    candidates: OptionsParityCandidate[];
    rejections: OptionsParityRejection[];
}
