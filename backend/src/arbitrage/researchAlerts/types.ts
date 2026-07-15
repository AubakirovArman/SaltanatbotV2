import type { NotifyPayload } from "../../trading/notifications.js";
import type { RouteEconomicsRequest, RouteEconomicsResult, VersionedEvidence } from "../economics/index.js";

export const RESEARCH_ALERT_FAMILIES = ["basis", "cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future", "triangular", "native-spread", "options-parity", "n-leg", "cex-dex"] as const;

export type ResearchAlertFamily = (typeof RESEARCH_ALERT_FAMILIES)[number];
export type ResearchAlertQuality = "unverified" | "degraded" | "fresh" | "verified";
export type ResearchAlertLifecycleKind = "basis" | "pairwise" | "triangular" | "native-spread" | "options-parity" | "n-leg" | "cex-dex";

export interface ResearchAlertEconomicLegIdentity {
  venue: string;
  instrumentId: string;
  marketType: "spot" | "perpetual" | "future" | "option" | "native-spread";
  side: "buy" | "sell";
}

/** Exact reviewed identity. Display symbols are deliberately absent. */
export interface ResearchAlertEconomicIdentity {
  schemaVersion: 1;
  economicAssetId: string;
  status: "reviewed";
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
  legs: readonly ResearchAlertEconomicLegIdentity[];
}

export interface ResearchAlertLifecycleEvidence {
  universeId: string;
  policyId: string;
  kind: ResearchAlertLifecycleKind;
  routeId: string;
  observationId: string;
  status: "first-seen" | "confirmed" | "decaying" | "expired";
  actionable: boolean;
  lastObservationAt: number;
  effectiveEvidenceQuality: ResearchAlertQuality;
  evidenceComplete: boolean;
  evidenceSourceIds: readonly string[];
}

export interface ResearchAlertCandidate {
  routeId: string;
  family: ResearchAlertFamily;
  economicIdentity: ResearchAlertEconomicIdentity;
  lifecycle: ResearchAlertLifecycleEvidence;
  economicsRequest: RouteEconomicsRequest;
  /** Route-engine gross PnL in economicsRequest.valuationAsset before route-economics costs. */
  grossProfitValuation: number;
  /** Executable visible/account-constrained route capacity, in the valuation asset. */
  capacityValuation: number;
  /** Versioned provenance for both route-engine gross profit and capacity. */
  routeEvidence: VersionedEvidence;
}

export interface ResearchAlertCoverage {
  /** True only when all configured families and required sources were evaluated. */
  complete: boolean;
  stale: boolean;
  truncated: boolean;
  failedSources: readonly string[];
}

export interface ResearchAlertSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  evaluatedAt: number;
  coverage: ResearchAlertCoverage;
  candidates: readonly ResearchAlertCandidate[];
}

export interface ResearchAlertPolicyInput {
  id?: string;
  name: string;
  families: readonly ResearchAlertFamily[];
  economicAssetIds: readonly string[];
  minimumConservativeNetProfit: number;
  minimumNetEdgeBps: number;
  minimumCapacityValuation: number;
  maximumRiskCapitalValuation?: number;
  minimumEvidenceQuality: "fresh" | "verified";
  maximumObservationAgeMs: number;
  maximumEconomicsAgeMs: number;
  maximumIdentityAgeMs: number;
  cooldownSeconds: number;
  enabled: boolean;
}

export interface ResearchAlertPolicy extends ResearchAlertPolicyInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  lastDelivery?: ResearchAlertDeliverySummary;
}

export type ResearchAlertRejectionCode =
  | "policy-filter"
  | "identity-invalid"
  | "identity-stale"
  | "identity-mismatch"
  | "lifecycle-invalid"
  | "observation-stale"
  | "economics-ineligible"
  | "economics-stale"
  | "route-evidence-invalid"
  | "capital-unpriced"
  | "capital-threshold"
  | "capacity-threshold"
  | "profit-threshold"
  | "edge-threshold";

export interface ResearchAlertRejection {
  code: ResearchAlertRejectionCode;
  message: string;
}

export interface ResearchAlertAssessment {
  policyId: string;
  routeId: string;
  family: ResearchAlertFamily;
  dedupKey: string;
  eligible: boolean;
  conservativeNetProfit: number;
  netEdgeBps: number;
  riskCapitalValuation: number;
  economics: RouteEconomicsResult;
  rejections: ResearchAlertRejection[];
}

export interface ResearchAlertOutboxIntent {
  policyId: string;
  dedupKey: string;
  routeId: string;
  family: ResearchAlertFamily;
  economicAssetId: string;
  observationId: string;
  conservativeNetProfit: number;
  netEdgeBps: number;
  riskCapitalValuation: number;
  capacityValuation: number;
  createdAt: number;
  researchOnly: true;
  executionPermission: false;
  payload: NotifyPayload;
}

export type ResearchAlertDeliveryStatus = "queued" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";

export interface ResearchAlertDeliverySummary {
  id: string;
  dedupKey: string;
  routeId: string;
  family: ResearchAlertFamily;
  status: ResearchAlertDeliveryStatus;
  attempts: number;
  queuedAt: number;
  nextAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
}

export interface ResearchAlertDelivery extends ResearchAlertDeliverySummary, ResearchAlertOutboxIntent {
  id: string;
  status: ResearchAlertDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  queuedAt: number;
  nextAttemptAt?: number;
  lastAttemptAt?: number;
  leaseUntil?: number;
  deliveredAt?: number;
  lastError?: string;
}

export interface ResearchAlertPairState {
  policyId: string;
  dedupKey: string;
  eligible: boolean;
  updatedAt: number;
  lastObservationId?: string;
  lastTriggeredAt?: number;
  lastDeliveryId?: string;
}

export interface ResearchAlertPersistedState {
  version: 1;
  lastEvaluatedAt?: number;
  policies: ResearchAlertPolicy[];
  pairs: Record<string, ResearchAlertPairState>;
  initializedPolicies: Record<string, true>;
  snapshotFingerprints: Record<string, { fingerprint: string; evaluatedAt: number }>;
  deliveries: ResearchAlertDelivery[];
}

export interface ResearchAlertEvaluationResult {
  schemaVersion: 1;
  researchOnly: true;
  executionPermission: false;
  snapshotId: string;
  idempotent: boolean;
  coverageComplete: boolean;
  assessments: ResearchAlertAssessment[];
  selected: ResearchAlertAssessment[];
  intents: ResearchAlertOutboxIntent[];
}

export interface ResearchAlertServiceResult extends ResearchAlertEvaluationResult {
  queuedDeliveryIds: string[];
  attemptedDeliveryIds: string[];
  deliveredDeliveryIds: string[];
  retryingDeliveryIds: string[];
  failedDeliveryIds: string[];
}

export interface ResearchAlertStorage {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}
