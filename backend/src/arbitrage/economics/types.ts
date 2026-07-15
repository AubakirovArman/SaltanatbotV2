export type ArbitrageOutcomeClass = "locked" | "projected" | "statistical";
export type EconomicMarketType = "spot" | "perpetual" | "future" | "option" | "native-spread";

export interface VersionedEvidence {
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
}

export interface EconomicFxRate {
  baseAsset: string;
  quoteAsset: string;
  bid: number;
  ask: number;
  evidence: VersionedEvidence;
}

export interface FeeTier {
  venue: string;
  accountScope: string;
  tier: string;
  makerBps: number;
  takerBps: number;
  feeAsset: string;
  /** Required when feeAsset is not the leg quote asset. */
  rebateCreditVerified: boolean;
  evidence: VersionedEvidence;
}

export interface EconomicLeg {
  legId: string;
  venue: string;
  instrumentId: string;
  marketType: EconomicMarketType;
  side: "buy" | "sell";
  liquidity: "maker" | "taker";
  baseAsset: string;
  quoteAsset: string;
  baseQuantity: number;
  price: number;
  feeTier: FeeTier;
  /** Venue-derived fee quantity. Mandatory for non-quote fee assets. */
  feeAssetQuantity?: number;
}

export interface FundingProjection {
  instrumentId: string;
  position: "long" | "short";
  notionalQuote: number;
  settlementAt: number;
  rateBps: number;
  kind: "settled" | "venue-estimate" | "manual-stress";
  evidence: VersionedEvidence;
}

export interface BorrowFacility {
  venue: string;
  asset: string;
  requestedQuantity: number;
  availableQuantity: number;
  annualRateBps: number;
  recallable: boolean;
  evidence: VersionedEvidence;
}

export interface TransferNetworkState {
  fromVenue: string;
  toVenue: string;
  asset: string;
  network: string;
  quantity: number;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  feeAsset: string;
  feeQuantity: number;
  estimatedArrivalMs: number;
  evidence: VersionedEvidence;
}

export interface MarginRequirement {
  venue: string;
  instrumentId: string;
  collateralAsset: string;
  notionalQuote: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  safetyBufferBps: number;
  evidence: VersionedEvidence;
}

export interface CapitalBalance {
  venue: string;
  asset: string;
  available: number;
  reserved: number;
  haircutBps: number;
  evidence: VersionedEvidence;
}

export interface StableAssetPolicy {
  asset: string;
  referenceAsset: string;
  maximumDeviationBps: number;
}

export interface ExecutionFeasibility {
  requestedBaseQuantity: number;
  executableBaseQuantity: number;
  residualBaseQuantity: number;
  maximumResidualBps: number;
  atomicity: "venue-atomic" | "sequential" | "independent-venues";
  observedLegSkewMs: number;
  maximumLeggingMs: number;
}

export interface SettlementClaim {
  kind: "fixed" | "convergence-assumption" | "statistical-model";
  evidence: VersionedEvidence;
}

export interface RouteEconomicsRequest {
  routeId: string;
  evaluatedAt: number;
  horizonStart: number;
  horizonEnd: number;
  valuationAsset: string;
  maximumEvidenceAgeMs: number;
  maximumFutureClockSkewMs: number;
  maximumTransferArrivalMs: number;
  requireNonRecallableBorrow?: boolean;
  execution: ExecutionFeasibility;
  settlement: SettlementClaim;
  legs: readonly EconomicLeg[];
  fxRates: readonly EconomicFxRate[];
  stableAssets?: readonly StableAssetPolicy[];
  funding?: readonly FundingProjection[];
  borrow?: readonly BorrowFacility[];
  transfers?: readonly TransferNetworkState[];
  margin?: readonly MarginRequirement[];
  capital?: readonly CapitalBalance[];
}

export type EconomicFailureCode =
  | "invalid-request"
  | "stale-evidence"
  | "future-evidence"
  | "coverage-gap"
  | "missing-fx"
  | "stable-asset-depeg"
  | "fee-quantity-missing"
  | "funding-inconsistent"
  | "borrow-unavailable"
  | "borrow-recall-risk"
  | "transfer-unavailable"
  | "transfer-too-slow"
  | "margin-missing"
  | "capital-insufficient"
  | "quantity-mismatch"
  | "legging-window-exceeded";

export interface EconomicFailure {
  code: EconomicFailureCode;
  message: string;
  subject?: string;
}

export interface EconomicCostBreakdown {
  feesProjected: number;
  feesConservative: number;
  fundingProjected: number;
  fundingConservative: number;
  borrow: number;
  transfers: number;
  totalProjected: number;
  totalConservative: number;
}

export interface RequiredCapital {
  venue: string;
  asset: string;
  required: number;
  available: number;
  shortfall: number;
}

export interface RouteEconomicsResult {
  modelVersion: "route-economics-v1";
  routeId: string;
  evaluatedAt: number;
  eligible: boolean;
  outcomeClass: ArbitrageOutcomeClass;
  costs: EconomicCostBreakdown;
  requiredCapital: RequiredCapital[];
  failures: EconomicFailure[];
  riskFlags: string[];
  evidenceIds: string[];
}
