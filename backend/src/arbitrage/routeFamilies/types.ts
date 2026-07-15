import type {
  PairwiseBookSnapshot,
  PairwiseBorrowAssumption,
  PairwiseCapitalAssumption,
  PairwiseConvergenceAssumption,
  PairwiseDeliveryAssumption,
  PairwiseEvaluationOptions,
  PairwiseFundingAssumption,
  PairwiseInstrument,
  PairwiseInventoryAssumption,
  PairwiseOpportunity,
  PairwiseRebalanceAssumption,
  PairwiseRejection,
  PairwiseRoute
} from "../engines/pairwise/index.js";

export const ROUTE_FAMILIES = [
  "cross-venue-spot-spot",
  "reverse-cash-and-carry",
  "perpetual-perpetual-funding",
  "spot-dated-future",
  "calendar-spread",
  "perpetual-future"
] as const;

export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

export interface RouteFamilyCandidate {
  routeKey: string;
  routeId: string;
  family: RouteFamily;
  longInstrumentId: string;
  shortInstrumentId: string;
  longMarketType: PairwiseInstrument["marketType"];
  shortMarketType: PairwiseInstrument["marketType"];
  economicAssetId: string;
  edgeKind: "research-candidate";
  executable: false;
}

/** Route-specific assumptions. There is no wildcard/default scope. */
export interface RouteFamilyScope {
  family: RouteFamily;
  longInstrumentId: string;
  shortInstrumentId: string;
  requestedBaseQuantity: number;
  convergence?: PairwiseConvergenceAssumption;
  rebalance?: PairwiseRebalanceAssumption;
  delivery?: PairwiseDeliveryAssumption;
}

/**
 * Explicit point-in-time account/economic inputs. Values are keyed by exact instrument ID;
 * capability flags and ticker equality never substitute for them.
 */
export interface RouteFamilyAssumptionCatalog {
  scopes: readonly RouteFamilyScope[];
  capital: readonly (PairwiseCapitalAssumption & { instrumentId: string })[];
  inventory: readonly (PairwiseInventoryAssumption & { instrumentId: string })[];
  borrow: readonly (PairwiseBorrowAssumption & { instrumentId: string })[];
  funding: readonly PairwiseFundingAssumption[];
}

export interface RouteFamilyDiscoveryOptions {
  families?: readonly RouteFamily[];
  maxCandidates?: number;
}

export interface RouteFamilyDiscoveryResult {
  totalCompatibleCandidates: number;
  truncated: boolean;
  candidates: RouteFamilyCandidate[];
  rejectedInstruments: PairwiseRejection[];
}

export interface RouteFamilyEvaluationRequest {
  instruments: readonly PairwiseInstrument[];
  books: readonly PairwiseBookSnapshot[];
  assumptions: RouteFamilyAssumptionCatalog;
  families?: readonly RouteFamily[];
  maxRoutes?: number;
  options: PairwiseEvaluationOptions;
}

export interface RouteFamilyEvaluationResponse {
  engine: "route-families-v1";
  executionStatus: "research-only";
  executable: false;
  evaluatedAt: number;
  totalCompatibleCandidates: number;
  evaluatedRoutes: number;
  truncated: boolean;
  candidates: RouteFamilyCandidate[];
  opportunities: PairwiseOpportunity[];
  rejections: PairwiseRejection[];
  rejectedInstruments: PairwiseRejection[];
}

export type MaterializedRoute = { candidate: RouteFamilyCandidate; route: PairwiseRoute };
