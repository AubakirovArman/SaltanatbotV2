import { createHash } from "node:crypto";
import {
  ALERT_EVENT_SCHEMA_V1,
  NOTIFICATION_OUTBOX_SCHEMA_V1,
  parseAlertEventV1,
  parseAlertRuleDocumentV1,
  parseNotificationEnvelopeV1,
  parseNotificationOutboxItemV1,
  parsePriceThresholdAlertDefinitionV1,
  type AlertEventTypeV1,
  type AlertEventV1,
  type AlertRuleDocumentV1,
  type NotificationOutboxItemV1,
  type PriceThresholdAlertDefinitionV1,
} from "@saltanatbotv2/contracts";
import { priceThresholdAlertScopeKey, type PriceThresholdAlertRuntimeStateV1 } from "./priceEvaluator.js";
import type { AlertRuleRecord, ClaimedPriceAlertRule } from "./repositoryTypes.js";

type Timestamp = Date | string;

export interface AlertRuleRow {
  id: string;
  owner_user_id: string;
  client_id: string;
  status: "active" | "disabled" | "archived";
  current_revision: string | number;
  authorization_revision: string | number;
  evaluation_interval_seconds: number;
  next_evaluation_at: Timestamp | null;
  evaluation_failure_count: number;
  last_evaluated_at: Timestamp | null;
  last_success_at: Timestamp | null;
  last_error_code: string | null;
  last_error_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
  rule_kind: string;
  definition: unknown;
  definition_hash: string;
  revision_created_at?: Timestamp;
}

export interface ClaimedPriceAlertRow extends AlertRuleRow {
  lease_owner: string;
  lease_token: string;
  lease_generation: string | number;
  lease_expires_at: Timestamp;
  state_key: string | null;
  state: unknown | null;
  state_rule_revision: string | number | null;
  state_revision: string | number | null;
}

export interface AlertEventRow {
  id: string;
  alert_rule_id: string;
  rule_revision: string | number;
  rule_kind: string;
  state_key: string;
  idempotency_key: string;
  event_type: "armed" | "rearmed" | "state_changed" | "triggered" | "suppressed" | "evaluation_error";
  to_state: string | null;
  observation_id: string | null;
  observation_hash: string | null;
  evidence: Record<string, unknown>;
  occurred_at: Timestamp;
}

export interface NotificationOutboxRow {
  id: string;
  payload: unknown;
  created_at: Timestamp;
  channel: "in-app" | "telegram";
  delivery_status: "queued" | "sending" | "retrying" | "delivered" | "dead_letter" | "cancelled" | "held";
  attempt: number;
  max_attempts: number;
  run_after: Timestamp;
  delivered_at: Timestamp | null;
  error_message: string | null;
}

export interface LockedAlertRuleRow extends AlertRuleRow {
  user_status: "pending" | "active" | "disabled";
  user_must_change_password: boolean;
  user_authorization_revision: string | number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_generation: string | number;
  lease_expires_at: Timestamp | null;
  lease_valid: boolean;
  database_now_ms: string | number;
}

export function selectAlertRuleSql(): string {
  return `SELECT
    r.id, r.owner_user_id, r.client_id, r.status, r.current_revision,
    r.authorization_revision, r.evaluation_interval_seconds,
    r.next_evaluation_at, r.evaluation_failure_count, r.last_evaluated_at,
    r.last_success_at, r.last_error_code, r.last_error_at, r.created_at,
    r.updated_at, r.archived_at, r.rule_kind,
    revision.definition, revision.definition_hash,
    revision.created_at AS revision_created_at
  FROM alert_rules r
  INNER JOIN alert_rule_revisions revision
    ON revision.owner_user_id = r.owner_user_id
   AND revision.alert_rule_id = r.id
   AND revision.revision = r.current_revision`;
}

export function lockedAlertRuleSql(): string {
  return `SELECT r.id, r.owner_user_id, r.client_id, r.status, r.current_revision, r.authorization_revision,
    r.evaluation_interval_seconds, r.next_evaluation_at, r.evaluation_failure_count, r.last_evaluated_at,
    r.last_success_at, r.last_error_code, r.last_error_at, r.created_at, r.updated_at, r.archived_at,
    r.rule_kind, r.lease_owner, r.lease_token, r.lease_generation, r.lease_expires_at,
    (r.lease_expires_at > clock_timestamp()) AS lease_valid,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS database_now_ms,
    revision.definition, revision.definition_hash, revision.created_at AS revision_created_at,
    owner_user.status AS user_status, owner_user.must_change_password AS user_must_change_password,
    owner_user.authorization_revision AS user_authorization_revision
   FROM alert_rules r INNER JOIN alert_rule_revisions revision ON revision.owner_user_id = r.owner_user_id
    AND revision.alert_rule_id = r.id AND revision.revision = r.current_revision
   INNER JOIN users owner_user ON owner_user.id = r.owner_user_id
   WHERE r.owner_user_id = $1 AND r.id = $2 FOR UPDATE OF r`;
}

export function mapAlertRule(row: AlertRuleRow): AlertRuleRecord {
  const definition = parseAlertRuleDocumentV1(row.definition);
  if (definition.kind !== row.rule_kind) throw new Error("Stored alert rule kind does not match its immutable revision.");
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    clientId: row.client_id,
    status: row.status,
    currentRevision: positiveSafeInteger(row.current_revision, "alert revision"),
    authorizationRevision: positiveSafeInteger(row.authorization_revision, "authorization revision"),
    evaluationIntervalSeconds: row.evaluation_interval_seconds,
    ...(row.next_evaluation_at ? { nextEvaluationAt: iso(row.next_evaluation_at) } : {}),
    evaluationFailureCount: row.evaluation_failure_count,
    ...(row.last_evaluated_at ? { lastEvaluatedAt: iso(row.last_evaluated_at) } : {}),
    ...(row.last_success_at ? { lastSuccessAt: iso(row.last_success_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_at ? { lastErrorAt: iso(row.last_error_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}),
    definitionHash: row.definition_hash,
    definition,
  };
}

export function mapClaimedPriceAlert(row: ClaimedPriceAlertRow): ClaimedPriceAlertRule {
  const base = mapAlertRule(row);
  const definition = parsePriceThresholdAlertDefinitionV1(base.definition);
  const expectedStateKey = priceThresholdAlertScopeKey(definition);
  if (row.state_key !== null && row.state_key !== expectedStateKey) {
    throw new Error("Stored price alert state scope does not match its immutable rule revision.");
  }
  const stateKey = row.state_key ?? expectedStateKey;
  const stateRevision = row.state_revision === null ? 0 : positiveSafeInteger(row.state_revision, "state revision");
  const storedRuleRevision = row.state_rule_revision === null ? undefined : positiveSafeInteger(row.state_rule_revision, "state rule revision");
  if (storedRuleRevision !== undefined && storedRuleRevision > base.currentRevision) {
    throw new Error("Stored price alert state belongs to a future rule revision.");
  }
  return {
    ...base,
    definition,
    workerId: row.lease_owner,
    leaseToken: row.lease_token,
    leaseGeneration: nonnegativeSafeInteger(row.lease_generation, "lease generation"),
    leaseExpiresAt: iso(row.lease_expires_at),
    stateKey,
    stateRevision,
    state:
      storedRuleRevision === undefined || storedRuleRevision < base.currentRevision
        ? defaultPriceAlertRuntimeState(row.revision_created_at ?? row.created_at)
        : parsePriceAlertRuntimeStateStrict(row.state),
  };
}

export function mapAlertEvent(row: AlertEventRow): AlertEventV1 {
  const eventType = publicEventType(row);
  const summary = typeof row.evidence.summary === "string" && row.evidence.summary.trim() ? row.evidence.summary.trim().slice(0, 512) : defaultEventSummary(eventType);
  return parseAlertEventV1({
    schemaVersion: ALERT_EVENT_SCHEMA_V1,
    id: row.id,
    ruleId: row.alert_rule_id,
    ruleRevision: positiveSafeInteger(row.rule_revision, "event rule revision"),
    ruleKind: row.rule_kind,
    eventType,
    subjectKey: row.state_key,
    transitionKey: /^[0-9a-f]{64}$/.test(row.idempotency_key) ? row.idempotency_key : sha256(row.idempotency_key),
    ...(row.observation_id ? { evidenceId: row.observation_id } : {}),
    ...(row.observation_hash ? { evidenceFingerprint: row.observation_hash } : {}),
    occurredAt: iso(row.occurred_at),
    summary,
    researchOnly: true,
    executionPermission: false,
  });
}

export function mapNotificationOutbox(row: NotificationOutboxRow): NotificationOutboxItemV1 {
  const status = row.delivery_status === "dead_letter" ? "dead-letter" : row.delivery_status;
  return parseNotificationOutboxItemV1({
    schemaVersion: NOTIFICATION_OUTBOX_SCHEMA_V1,
    id: row.id,
    channel: row.channel,
    status,
    attempts: row.attempt,
    maxAttempts: row.max_attempts,
    queuedAt: iso(row.created_at),
    ...(status !== "delivered" ? { nextAttemptAt: iso(row.run_after) } : {}),
    ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}),
    ...(row.error_message ? { lastError: row.error_message } : {}),
    envelope: parseNotificationEnvelopeV1(row.payload),
    researchOnly: true,
    executionPermission: false,
  });
}

export function parseAndHashAlertDefinition(value: unknown): { definition: AlertRuleDocumentV1; serialized: string; hash: string } {
  const definition = parseAlertRuleDocumentV1(value);
  const serialized = canonicalJson(definition);
  return { definition, serialized, hash: sha256(serialized) };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Alert documents cannot contain unsupported JSON values.");
  return serialized;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function positiveSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
}

export function iso(value: Timestamp): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Stored timestamp is invalid.");
  return date.toISOString();
}

function nonnegativeSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
}

export function parsePriceAlertRuntimeStateStrict(value: unknown): PriceThresholdAlertRuntimeStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored price alert runtime state is malformed.");
  const state = value as Record<string, unknown>;
  const allowed = new Set(["status", "armedAt", "initialized", "eligible", "lastEvaluatedBarTime", "triggeredByTransitionKey"]);
  if (Object.keys(state).some((key) => !allowed.has(key))) throw new Error("Stored price alert runtime state is malformed.");
  if ((state.status !== "armed" && state.status !== "triggered") || typeof state.armedAt !== "number" || !Number.isSafeInteger(state.armedAt) || state.armedAt < 0 || typeof state.initialized !== "boolean" || typeof state.eligible !== "boolean") {
    throw new Error("Stored price alert runtime state is malformed.");
  }
  const result: PriceThresholdAlertRuntimeStateV1 = { status: state.status, armedAt: state.armedAt, initialized: state.initialized, eligible: state.eligible };
  if (state.lastEvaluatedBarTime !== undefined) {
    if (typeof state.lastEvaluatedBarTime !== "number" || !Number.isSafeInteger(state.lastEvaluatedBarTime) || state.lastEvaluatedBarTime < 0) throw new Error("Stored price alert runtime state is malformed.");
    result.lastEvaluatedBarTime = state.lastEvaluatedBarTime;
  }
  if (state.triggeredByTransitionKey !== undefined) {
    if (typeof state.triggeredByTransitionKey !== "string" || !/^[0-9a-f]{64}$/.test(state.triggeredByTransitionKey)) throw new Error("Stored price alert runtime state is malformed.");
    result.triggeredByTransitionKey = state.triggeredByTransitionKey;
  }
  if ((!result.initialized && (result.eligible || result.lastEvaluatedBarTime !== undefined)) || (result.initialized && result.lastEvaluatedBarTime === undefined)) throw new Error("Stored price alert runtime state is malformed.");
  if (result.status === "triggered") {
    if (!result.initialized || !result.eligible || !result.triggeredByTransitionKey) throw new Error("Stored price alert runtime state is malformed.");
  } else if (result.triggeredByTransitionKey !== undefined) {
    throw new Error("Stored price alert runtime state is malformed.");
  }
  return result;
}

export function defaultPriceAlertRuntimeState(armedAt: Timestamp): PriceThresholdAlertRuntimeStateV1 {
  return { status: "armed", armedAt: new Date(armedAt).getTime(), initialized: false, eligible: false };
}

function publicEventType(row: AlertEventRow): AlertEventTypeV1 {
  if (row.event_type === "state_changed") {
    if (row.to_state === "eligible") return "eligible";
    if (row.to_state === "stale") return "stale";
    if (row.to_state === "error") return "error";
    return "ineligible";
  }
  if (row.event_type === "evaluation_error") return "error";
  return row.event_type;
}

function defaultEventSummary(eventType: AlertEventTypeV1): string {
  return `Alert ${eventType.replaceAll("_", " ")}.`;
}
