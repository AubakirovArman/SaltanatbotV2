/**
 * One presentation/research contract shared by heterogeneous opportunity
 * engines. It deliberately does not turn research output into an order API.
 */

export const MARKET_OPPORTUNITY_SCHEMA_VERSION = "market-opportunity-v1" as const;

export type MarketOpportunityFamily =
  | "cash-and-carry"
  | "reverse-cash-and-carry"
  | "spot-spot"
  | "perpetual-perpetual"
  | "spot-dated-future"
  | "perpetual-future"
  | "calendar-spread"
  | "dated-futures-spread"
  | "venue-native-spread"
  | "n-leg-cycle"
  | "order-book-signal";

export type MarketOpportunityBlockStage = "market-data" | "economics" | "strategy-evidence" | "paper-execution" | "live-execution";

export interface MarketOpportunityBlocker {
  code: string;
  stage: MarketOpportunityBlockStage;
  message: string;
  subject?: string;
}

export interface MarketOpportunityLeg {
  id: string;
  venue: string;
  instrumentId: string;
  symbol: string;
  marketType: "spot" | "perpetual" | "future" | "native-spread";
  /** `derived` means a venue-native spread action has not selected bid/ask yet. */
  side: "buy" | "sell" | "derived";
  role: "long" | "short" | "cycle" | "component";
  identityScope: "canonical-instrument" | "venue-native-symbol";
  quantity?: number;
  quantityUnit: "base" | "quote" | "contract" | "native";
  /** Concrete asset/unit label when the semantic quantity unit alone is ambiguous. */
  quantityAsset?: string;
  referencePrice?: number;
  visibleCapacity?: number;
  evidenceId?: string;
}

export interface MarketOpportunityEconomics {
  outcome: "projected" | "research-simulation" | "two-sided-quote";
  grossEdgeBps?: number;
  netEdgeBps?: number;
  expectedNetProfit?: { value: number; currency: string };
  /** Cost numbers are comparable only inside the declared coverage. */
  costCoverage: "unknown" | "aggregate-estimate" | "entry-public-fees-only" | "visible-depth-and-declared-fees";
  aggregateEstimatedCostBps?: number;
  entryFees?: { value: number; currency: string };
  funding: "included" | "excluded" | "unknown";
  borrow: "included" | "excluded" | "unknown";
  slippage: "visible-depth" | "estimate" | "excluded" | "unknown";
  /** Exact venue-native two-sided spread quote. Width is a crossing cost, not an edge. */
  twoSidedQuote?: {
    bidPrice: number;
    askPrice: number;
    absoluteWidth: number;
    priceUnit: string;
  };
  /** Exact browser cost scenario used when a basis row is filtered, ranked and handed off. */
  basisScenario?: MarketOpportunityBasisScenario;
}

export interface MarketOpportunityBasisScenario {
  model: "browser-basis-cost-v1";
  computedAt: number;
  requestedNotionalUsd: number;
  executableNotionalUsd: number;
  assumptions: {
    spotTakerBps: number;
    perpetualTakerBps: number;
    roundTripSlippageReserveBps: number;
    expectedHoldingHours: number;
    annualBorrowRatePct: number;
    transferCostUsd: number;
  };
  costBreakdownBps: {
    tradingFees: number;
    slippage: number;
    borrow: number;
    transfer: number;
    funding: number;
    total: number;
    fundingSettlementCount: number;
    fundingScheduleVerified: boolean;
  };
}

export interface MarketOpportunityCapacity {
  quantity?: number;
  quantityUnit?: MarketOpportunityLeg["quantityUnit"];
  quantityAsset?: string;
  notional?: { value: number; currency: string };
  depthLimited?: boolean;
}

export interface MarketOpportunityEvidence {
  evaluatedAt: number;
  quoteAgeMs: number;
  legSkewMs: number;
  sequenceContinuity: "verified" | "unverified";
  exchangeTimestamps: "verified" | "unverified";
  dataQuality: "fresh" | "stale" | "skewed" | "unverified";
  sourceIds: string[];
  provenanceIds: string[];
}

export interface MarketOpportunityExecutionBoundary {
  research: "available";
  paperPlan: "ready" | "blocked" | "unsupported";
  live: "blocked";
  atomicity: "none" | "venue-native";
  paperBlockers: string[];
  liveBlockers: string[];
}

export interface MarketOpportunityEnvelope {
  schemaVersion: typeof MARKET_OPPORTUNITY_SCHEMA_VERSION;
  id: string;
  family: MarketOpportunityFamily;
  kind: "spread" | "cycle" | "microstructure";
  source: {
    engine: string;
    opportunityId: string;
    evaluatedAt: number;
  };
  legs: MarketOpportunityLeg[];
  economics: MarketOpportunityEconomics;
  capacity: MarketOpportunityCapacity;
  evidence: MarketOpportunityEvidence;
  execution: MarketOpportunityExecutionBoundary;
  blockers: MarketOpportunityBlocker[];
}

export interface MarketOpportunityValidation {
  ok: boolean;
  errors: string[];
}
