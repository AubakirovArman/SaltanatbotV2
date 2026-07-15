import {
  RESEARCH_ALERT_FAMILIES,
  type ResearchAlertDeliveriesResponse,
  type ResearchAlertDelivery,
  type ResearchAlertDeliverySummary,
  type ResearchAlertDeliveryStatus,
  type ResearchAlertFamily,
  type ResearchAlertPoliciesResponse,
  type ResearchAlertPolicy,
  type ResearchAlertPolicyInput,
  type ResearchAlertPolicyResponse,
  type ResearchAlertState
} from "./researchAlertTypes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ECONOMIC_ASSET = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,95}$/;
const DELIVERY_STATUSES = ["queued", "sending", "retrying", "delivered", "failed", "cancelled"] as const;
const FAMILY_SET = new Set<string>(RESEARCH_ALERT_FAMILIES);
const STATUS_SET = new Set<string>(DELIVERY_STATUSES);
const POLICY_REQUIRED = [
  "id",
  "name",
  "families",
  "economicAssetIds",
  "minimumConservativeNetProfit",
  "minimumNetEdgeBps",
  "minimumCapacityValuation",
  "minimumEvidenceQuality",
  "maximumObservationAgeMs",
  "maximumEconomicsAgeMs",
  "maximumIdentityAgeMs",
  "cooldownSeconds",
  "enabled",
  "createdAt",
  "updatedAt"
] as const;
const POLICY_OPTIONAL = ["maximumRiskCapitalValuation", "lastTriggeredAt", "lastDelivery"] as const;
const INPUT_REQUIRED = [
  "name",
  "families",
  "economicAssetIds",
  "minimumConservativeNetProfit",
  "minimumNetEdgeBps",
  "minimumCapacityValuation",
  "minimumEvidenceQuality",
  "maximumObservationAgeMs",
  "maximumEconomicsAgeMs",
  "maximumIdentityAgeMs",
  "cooldownSeconds",
  "enabled"
] as const;
const INPUT_OPTIONAL = ["id", "maximumRiskCapitalValuation"] as const;
const SUMMARY_REQUIRED = ["id", "dedupKey", "routeId", "family", "status", "attempts", "queuedAt"] as const;
const SUMMARY_OPTIONAL = ["nextAttemptAt", "deliveredAt", "lastError"] as const;
const DELIVERY_REQUIRED = [
  ...SUMMARY_REQUIRED,
  "policyId",
  "economicAssetId",
  "observationId",
  "conservativeNetProfit",
  "netEdgeBps",
  "riskCapitalValuation",
  "capacityValuation",
  "createdAt",
  "researchOnly",
  "executionPermission",
  "maxAttempts"
] as const;
const DELIVERY_OPTIONAL = [...SUMMARY_OPTIONAL, "lastAttemptAt", "leaseUntil"] as const;

export function parseResearchAlertState(input: unknown): ResearchAlertState {
  const value = object(input, "research alert state");
  exact(value, ["schemaVersion", "researchOnly", "executionPermission", "policies", "deliveries"], ["lastWorkerError"], "research alert state");
  safetyEnvelope(value, "research alert state");
  const policies = boundedArray(value.policies, "policies", 50).map((item, index) => parsePolicy(item, `policies[${index}]`));
  const deliveries = boundedArray(value.deliveries, "deliveries", 100).map((item, index) => parseDelivery(item, `deliveries[${index}]`));
  const state: ResearchAlertState = { schemaVersion: 1, researchOnly: true, executionPermission: false, policies, deliveries };
  if (value.lastWorkerError !== undefined) state.lastWorkerError = string(value.lastWorkerError, "lastWorkerError", 1, 2_048);
  return state;
}

export function parseResearchAlertDeliveriesResponse(input: unknown, maximum = 100): ResearchAlertDeliveriesResponse {
  const limit = integer(maximum, "delivery response limit", 1, 500);
  const value = object(input, "research alert deliveries response");
  exact(value, ["schemaVersion", "researchOnly", "executionPermission", "deliveries"], [], "research alert deliveries response");
  safetyEnvelope(value, "research alert deliveries response");
  return {
    schemaVersion: 1,
    researchOnly: true,
    executionPermission: false,
    deliveries: boundedArray(value.deliveries, "deliveries", limit).map((item, index) => parseDelivery(item, `deliveries[${index}]`))
  };
}

export function parseResearchAlertPolicyResponse(input: unknown): ResearchAlertPolicyResponse {
  const value = object(input, "research alert policy response");
  exact(value, ["schemaVersion", "researchOnly", "executionPermission", "policy"], [], "research alert policy response");
  safetyEnvelope(value, "research alert policy response");
  return { schemaVersion: 1, researchOnly: true, executionPermission: false, policy: parsePolicy(value.policy, "policy") };
}

export function parseResearchAlertPoliciesResponse(input: unknown): ResearchAlertPoliciesResponse {
  const value = object(input, "research alert policies response");
  exact(value, ["schemaVersion", "researchOnly", "executionPermission", "policies"], [], "research alert policies response");
  safetyEnvelope(value, "research alert policies response");
  return {
    schemaVersion: 1,
    researchOnly: true,
    executionPermission: false,
    policies: boundedArray(value.policies, "policies", 50).map((item, index) => parsePolicy(item, `policies[${index}]`))
  };
}

export function parseResearchAlertPolicyInput(input: unknown): ResearchAlertPolicyInput {
  const value = object(input, "research alert policy input");
  exact(value, INPUT_REQUIRED, INPUT_OPTIONAL, "research alert policy input");
  const policy: ResearchAlertPolicyInput = {
    name: trimmedString(value.name, "name", 1, 120),
    families: uniqueFamilies(value.families, "families"),
    economicAssetIds: uniqueEconomicAssets(value.economicAssetIds, "economicAssetIds"),
    minimumConservativeNetProfit: finite(value.minimumConservativeNetProfit, "minimumConservativeNetProfit", -1e15, 1e15),
    minimumNetEdgeBps: finite(value.minimumNetEdgeBps, "minimumNetEdgeBps", -10_000, 1_000_000),
    minimumCapacityValuation: finite(value.minimumCapacityValuation, "minimumCapacityValuation", 0, 1e15),
    minimumEvidenceQuality: oneOf(value.minimumEvidenceQuality, ["fresh", "verified"] as const, "minimumEvidenceQuality"),
    maximumObservationAgeMs: integer(value.maximumObservationAgeMs, "maximumObservationAgeMs", 100, 86_400_000),
    maximumEconomicsAgeMs: integer(value.maximumEconomicsAgeMs, "maximumEconomicsAgeMs", 100, 86_400_000),
    maximumIdentityAgeMs: integer(value.maximumIdentityAgeMs, "maximumIdentityAgeMs", 100, 90 * 86_400_000),
    cooldownSeconds: integer(value.cooldownSeconds, "cooldownSeconds", 60, 86_400),
    enabled: boolean(value.enabled, "enabled")
  };
  if (value.id !== undefined) policy.id = identifier(value.id, "id", UUID);
  if (value.maximumRiskCapitalValuation !== undefined) policy.maximumRiskCapitalValuation = finite(value.maximumRiskCapitalValuation, "maximumRiskCapitalValuation", 0, 1e15, true);
  return policy;
}

function parsePolicy(input: unknown, path: string): ResearchAlertPolicy {
  const value = object(input, path);
  exact(value, POLICY_REQUIRED, POLICY_OPTIONAL, path);
  const policyInput = parseResearchAlertPolicyInput({
    id: value.id,
    name: value.name,
    families: value.families,
    economicAssetIds: value.economicAssetIds,
    minimumConservativeNetProfit: value.minimumConservativeNetProfit,
    minimumNetEdgeBps: value.minimumNetEdgeBps,
    minimumCapacityValuation: value.minimumCapacityValuation,
    ...(value.maximumRiskCapitalValuation !== undefined ? { maximumRiskCapitalValuation: value.maximumRiskCapitalValuation } : {}),
    minimumEvidenceQuality: value.minimumEvidenceQuality,
    maximumObservationAgeMs: value.maximumObservationAgeMs,
    maximumEconomicsAgeMs: value.maximumEconomicsAgeMs,
    maximumIdentityAgeMs: value.maximumIdentityAgeMs,
    cooldownSeconds: value.cooldownSeconds,
    enabled: value.enabled
  });
  const policy: ResearchAlertPolicy = {
    ...policyInput,
    id: identifier(value.id, `${path}.id`, UUID),
    createdAt: timestamp(value.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`)
  };
  if (policy.updatedAt < policy.createdAt) throw new Error(`${path}.updatedAt precedes createdAt`);
  if (value.lastTriggeredAt !== undefined) policy.lastTriggeredAt = timestamp(value.lastTriggeredAt, `${path}.lastTriggeredAt`);
  if (value.lastDelivery !== undefined) policy.lastDelivery = parseDeliverySummary(value.lastDelivery, `${path}.lastDelivery`);
  return policy;
}

function parseDelivery(input: unknown, path: string): ResearchAlertDelivery {
  const value = object(input, path);
  exact(value, DELIVERY_REQUIRED, DELIVERY_OPTIONAL, path);
  if (value.researchOnly !== true || value.executionPermission !== false) throw new Error(`${path} violates the research-only safety envelope`);
  const summary = parseDeliverySummary(value, path, DELIVERY_REQUIRED, DELIVERY_OPTIONAL);
  const delivery: ResearchAlertDelivery = {
    ...summary,
    policyId: identifier(value.policyId, `${path}.policyId`, UUID),
    economicAssetId: economicAsset(value.economicAssetId, `${path}.economicAssetId`),
    observationId: string(value.observationId, `${path}.observationId`, 1, 160),
    conservativeNetProfit: finite(value.conservativeNetProfit, `${path}.conservativeNetProfit`, -1e15, 1e15),
    netEdgeBps: finite(value.netEdgeBps, `${path}.netEdgeBps`, -10_000, 1_000_000),
    riskCapitalValuation: finite(value.riskCapitalValuation, `${path}.riskCapitalValuation`, 0, 1e15),
    capacityValuation: finite(value.capacityValuation, `${path}.capacityValuation`, 0, 1e15, true),
    createdAt: timestamp(value.createdAt, `${path}.createdAt`),
    researchOnly: true,
    executionPermission: false,
    maxAttempts: integer(value.maxAttempts, `${path}.maxAttempts`, 1, 20)
  };
  if (delivery.attempts > delivery.maxAttempts) throw new Error(`${path}.attempts exceeds maxAttempts`);
  if (value.lastAttemptAt !== undefined) delivery.lastAttemptAt = timestamp(value.lastAttemptAt, `${path}.lastAttemptAt`);
  if (value.leaseUntil !== undefined) delivery.leaseUntil = timestamp(value.leaseUntil, `${path}.leaseUntil`);
  return delivery;
}

function parseDeliverySummary(input: unknown, path: string, required: readonly string[] = SUMMARY_REQUIRED, optional: readonly string[] = SUMMARY_OPTIONAL): ResearchAlertDeliverySummary {
  const value = object(input, path);
  exact(value, required, optional, path);
  const summary: ResearchAlertDeliverySummary = {
    id: identifier(value.id, `${path}.id`, UUID),
    dedupKey: string(value.dedupKey, `${path}.dedupKey`, 1, 512),
    routeId: string(value.routeId, `${path}.routeId`, 1, 160),
    family: family(value.family, `${path}.family`),
    status: deliveryStatus(value.status, `${path}.status`),
    attempts: integer(value.attempts, `${path}.attempts`, 0, 20),
    queuedAt: timestamp(value.queuedAt, `${path}.queuedAt`)
  };
  if (value.nextAttemptAt !== undefined) summary.nextAttemptAt = timestamp(value.nextAttemptAt, `${path}.nextAttemptAt`);
  if (value.deliveredAt !== undefined) summary.deliveredAt = timestamp(value.deliveredAt, `${path}.deliveredAt`);
  if (value.lastError !== undefined) summary.lastError = string(value.lastError, `${path}.lastError`, 0, 2_048);
  return summary;
}

function safetyEnvelope(value: Record<string, unknown>, path: string) {
  if (value.schemaVersion !== 1 || value.researchOnly !== true || value.executionPermission !== false) throw new Error(`${path} violates the research-only safety envelope`);
}

function uniqueFamilies(input: unknown, path: string): ResearchAlertFamily[] {
  const values = boundedArray(input, path, RESEARCH_ALERT_FAMILIES.length).map((value, index) => family(value, `${path}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicate families`);
  return values;
}

function uniqueEconomicAssets(input: unknown, path: string): string[] {
  const values = boundedArray(input, path, 64).map((value, index) => economicAsset(value, `${path}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicate economic assets`);
  return values;
}

function family(input: unknown, path: string): ResearchAlertFamily {
  if (typeof input !== "string" || !FAMILY_SET.has(input)) throw new Error(`${path} is not a supported research family`);
  return input as ResearchAlertFamily;
}

function deliveryStatus(input: unknown, path: string): ResearchAlertDeliveryStatus {
  if (typeof input !== "string" || !STATUS_SET.has(input)) throw new Error(`${path} is not a supported delivery status`);
  return input as ResearchAlertDeliveryStatus;
}

function economicAsset(input: unknown, path: string): string {
  return identifier(input, path, ECONOMIC_ASSET);
}

function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(`${path} must be an object`);
  return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string) {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${path} has missing or unknown fields`);
}

function boundedArray(input: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) throw new Error(`${path} must contain at most ${maximum} rows`);
  return input;
}

function string(input: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof input !== "string" || input.length < minimum || input.length > maximum) throw new Error(`${path} must be a string from ${minimum} to ${maximum} characters`);
  return input;
}

function trimmedString(input: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof input !== "string") throw new Error(`${path} must be a string`);
  const value = input.trim();
  if (value.length < minimum || value.length > maximum) throw new Error(`${path} must be a string from ${minimum} to ${maximum} characters`);
  return value;
}

function identifier(input: unknown, path: string, pattern: RegExp): string {
  const value = string(input, path, 1, 512);
  if (!pattern.test(value)) throw new Error(`${path} has an invalid identifier`);
  return value;
}

function finite(input: unknown, path: string, minimum: number, maximum: number, exclusiveMinimum = false): number {
  if (typeof input !== "number" || !Number.isFinite(input) || (exclusiveMinimum ? input <= minimum : input < minimum) || input > maximum) throw new Error(`${path} must be a finite number in the supported range`);
  return input;
}

function integer(input: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) throw new Error(`${path} must be a safe integer from ${minimum} to ${maximum}`);
  return input;
}

function timestamp(input: unknown, path: string): number {
  return integer(input, path, 1, Number.MAX_SAFE_INTEGER);
}

function boolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${path} must be a boolean`);
  return input;
}

function oneOf<const Values extends readonly string[]>(input: unknown, values: Values, path: string): Values[number] {
  if (typeof input !== "string" || !values.includes(input)) throw new Error(`${path} has an unsupported value`);
  return input as Values[number];
}
