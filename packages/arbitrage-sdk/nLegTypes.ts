export interface NLegAssetUnit {
  venue: string;
  assetId: string;
  unitId: string;
}

export interface NLegFeeSchedule {
  scheduleId: string;
  tierId: string;
  takerBps: number;
  asset: NLegAssetUnit;
}

export interface NLegMarketInput {
  instrumentId: string;
  venue: string;
  symbol: string;
  marketType: "spot";
  base: NLegAssetUnit;
  quote: NLegAssetUnit;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  buyFee: NLegFeeSchedule;
  sellFee: NLegFeeSchedule;
}

export interface NLegBookInput {
  instrumentId: string;
  base: NLegAssetUnit;
  quote: NLegAssetUnit;
  bids: Array<readonly [price: number, baseQuantity: number]>;
  asks: Array<readonly [price: number, baseQuantity: number]>;
  exchangeTs: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
  complete: boolean;
  sequence: number;
  sequenceVerified: boolean;
  sourceId: string;
}

/** Caller-supplied, credential-free input for the bounded research simulator. */
export interface NLegResearchRequest {
  evaluatedAt: number;
  requestedStartQuantity: number;
  startAsset: NLegAssetUnit;
  markets: NLegMarketInput[];
  books: NLegBookInput[];
  graph?: {
    minLegs?: number;
    maxLegs?: number;
    maxCycles?: number;
    maxTraversalSteps?: number;
  };
  limits?: {
    minNetReturnBps?: number;
    maxQuoteAgeMs?: number;
    maxLegSkewMs?: number;
    maxFutureClockSkewMs?: number;
    depthSearchIterations?: number;
    maxDepthWalkSteps?: number;
  };
}

export interface NLegGraphWork {
  marketCount: number;
  maxMarkets: number;
  traversalSteps: number;
  maxTraversalSteps: number;
  maxCycles: number;
  truncated: boolean;
  truncationReason?: "cycle-limit" | "traversal-work-limit";
}

export interface NLegMetadataRejection {
  instrumentId: string;
  code: "invalid-metadata" | "duplicate-instrument" | "fee-conservation";
  message: string;
}

export type NLegRejectionCode = "missing-market" | "missing-book" | "identity-mismatch" | "invalid-book" | "incomplete-book" | "unsequenced-book" | "stale-book" | "skewed-books" | "fee-conservation" | "minimum-quantity" | "minimum-notional" | "insufficient-depth" | "work-limit" | "non-profitable";

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
  side: "buy" | "sell";
  from: NLegAssetUnit;
  to: NLegAssetUnit;
  fromKey: string;
  toKey: string;
  inputQuantity: number;
  tradeInputQuantity: number;
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
  feeDebit: "input" | "output";
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
  legs: NLegLegSimulation[];
  residuals: NLegResidual[];
  dustByAssetUnit: Record<string, number>;
  feesByAssetUnit: Record<string, number>;
  timestamps: {
    evaluatedAt: number;
    oldestExchangeTs: number;
    newestExchangeTs: number;
    oldestReceivedAt: number;
    newestReceivedAt: number;
    quoteAgeMs: number;
    legSkewMs: number;
    sequenceVerified: true;
    exchangeTimestampsVerified: true;
  };
  provenance: {
    engine: "n-leg-v1";
    canonicalSignature: string;
    instrumentIds: string[];
    feeScheduleIds: string[];
    bookSourceIds: string[];
  };
}

export interface NLegResearchResponse {
  engine: "n-leg-v1";
  readOnly: true;
  researchOnly: true;
  executable: false;
  execution: "none";
  evaluatedAt: number;
  requestedStartQuantity: number;
  startAsset: NLegAssetUnit;
  graph: NLegGraphWork;
  metadataRejections: NLegMetadataRejection[];
  totalCycles: number;
  opportunities: NLegOpportunity[];
  rejections: NLegRejection[];
}
