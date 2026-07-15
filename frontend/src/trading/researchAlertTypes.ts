export const RESEARCH_ALERT_FAMILIES = [
  "basis",
  "cross-venue-spot-spot",
  "reverse-cash-and-carry",
  "perpetual-perpetual-funding",
  "spot-dated-future",
  "calendar-spread",
  "perpetual-future",
  "triangular",
  "native-spread",
  "options-parity",
  "n-leg",
  "cex-dex"
] as const;

export type ResearchAlertFamily = (typeof RESEARCH_ALERT_FAMILIES)[number];
export type ResearchAlertEvidenceQuality = "fresh" | "verified";
export type ResearchAlertDeliveryStatus = "queued" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";

export interface ResearchAlertPolicyInput {
  id?: string;
  name: string;
  families: ResearchAlertFamily[];
  economicAssetIds: string[];
  minimumConservativeNetProfit: number;
  minimumNetEdgeBps: number;
  minimumCapacityValuation: number;
  maximumRiskCapitalValuation?: number;
  minimumEvidenceQuality: ResearchAlertEvidenceQuality;
  maximumObservationAgeMs: number;
  maximumEconomicsAgeMs: number;
  maximumIdentityAgeMs: number;
  cooldownSeconds: number;
  enabled: boolean;
}

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

export interface ResearchAlertPolicy extends ResearchAlertPolicyInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  lastDelivery?: ResearchAlertDeliverySummary;
}

/** The notification payload is intentionally absent from the protected browser contract. */
export interface ResearchAlertDelivery extends ResearchAlertDeliverySummary {
  policyId: string;
  economicAssetId: string;
  observationId: string;
  conservativeNetProfit: number;
  netEdgeBps: number;
  riskCapitalValuation: number;
  capacityValuation: number;
  createdAt: number;
  researchOnly: true;
  executionPermission: false;
  maxAttempts: number;
  lastAttemptAt?: number;
  leaseUntil?: number;
}

export interface ResearchAlertState {
  schemaVersion: 1;
  researchOnly: true;
  executionPermission: false;
  policies: ResearchAlertPolicy[];
  deliveries: ResearchAlertDelivery[];
  lastWorkerError?: string;
}

export interface ResearchAlertPolicyResponse {
  schemaVersion: 1;
  researchOnly: true;
  executionPermission: false;
  policy: ResearchAlertPolicy;
}

export interface ResearchAlertPoliciesResponse {
  schemaVersion: 1;
  researchOnly: true;
  executionPermission: false;
  policies: ResearchAlertPolicy[];
}

export interface ResearchAlertDeliveriesResponse {
  schemaVersion: 1;
  researchOnly: true;
  executionPermission: false;
  deliveries: ResearchAlertDelivery[];
}

export const DEFAULT_RESEARCH_ALERT_POLICY: ResearchAlertPolicyInput = {
  name: "",
  families: [...RESEARCH_ALERT_FAMILIES],
  economicAssetIds: [],
  minimumConservativeNetProfit: 0,
  minimumNetEdgeBps: 0,
  minimumCapacityValuation: 0,
  minimumEvidenceQuality: "fresh",
  maximumObservationAgeMs: 10_000,
  maximumEconomicsAgeMs: 10_000,
  maximumIdentityAgeMs: 30 * 86_400_000,
  cooldownSeconds: 300,
  enabled: true
};
