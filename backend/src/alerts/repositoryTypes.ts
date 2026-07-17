import type { AlertEventV1, AlertRuleDocumentV1, NotificationOutboxItemV1, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import type { PriceThresholdAlertRuntimeStateV1, PriceThresholdObservationV1, PriceThresholdTriggeredTransitionInputV1 } from "./priceEvaluator.js";

export const MAX_ENABLED_ALERT_RULES_PER_OWNER = 100;
export const MAX_RETAINED_ALERT_RULES_PER_OWNER = 200;
// Archiving is the user-visible delete path and must never be blocked. New
// history is capped instead, so bounded retention can catch up without hiding
// an operational rule or preventing its removal.
export const MAX_TOTAL_ALERT_RULE_HISTORY_PER_OWNER = 400;
// At the worst-case 1m cadence this is eight evaluations/second, equal to the
// conservative single-provider scheduler admission ceiling. R11 must soak and
// explicitly raise this beta bound rather than silently overcommitting it.
export const MAX_ACTIVE_ALERT_RULES_GLOBAL = 480;
// The retained-rule quota and the management-list ceiling are intentionally
// identical so every retained rule remains manageable without hidden rows.
export const ALERT_REPOSITORY_DEFAULT_LIST_LIMIT = MAX_RETAINED_ALERT_RULES_PER_OWNER;
export const ALERT_REPOSITORY_MAX_LIST_LIMIT = MAX_RETAINED_ALERT_RULES_PER_OWNER;

export type AlertRuleStatus = "active" | "disabled" | "archived";

export interface AlertRuleRecord {
  id: string;
  ownerUserId: string;
  clientId: string;
  status: AlertRuleStatus;
  currentRevision: number;
  authorizationRevision: number;
  evaluationIntervalSeconds: number;
  nextEvaluationAt?: string;
  evaluationFailureCount: number;
  lastEvaluatedAt?: string;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  definitionHash: string;
  definition: AlertRuleDocumentV1;
}

export interface ClaimedPriceAlertRule extends AlertRuleRecord {
  definition: PriceThresholdAlertDefinitionV1;
  workerId: string;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  stateKey: string;
  /** Exact durable state row revision observed while the lease was claimed; zero means no row exists. */
  stateRevision: number;
  state: PriceThresholdAlertRuntimeStateV1;
}

export interface CreateAlertRuleInput {
  ownerUserId: string;
  actorUserId: string;
  authorizationRevision: number;
  clientId: string;
  definition: unknown;
  evaluationIntervalSeconds?: number;
}

export interface UpdateAlertRuleInput {
  ownerUserId: string;
  actorUserId: string;
  ruleId: string;
  expectedRevision: number;
  authorizationRevision: number;
  definition: unknown;
}

export interface ArchiveAlertRuleInput {
  ownerUserId: string;
  actorUserId: string;
  ruleId: string;
  expectedRevision: number;
  authorizationRevision: number;
}

export interface RearmAlertRuleInput extends ArchiveAlertRuleInput {}

export interface ClaimPriceAlertInput {
  workerId: string;
  leaseMs: number;
}

export interface CompletePriceEvaluationInput {
  ownerUserId: string;
  ruleId: string;
  expectedRevision: number;
  authorizationRevision: number;
  workerId: string;
  leaseToken: string;
  leaseGeneration: number;
  expectedStateRevision: number;
  observation: PriceThresholdObservationV1;
  nextState: PriceThresholdAlertRuntimeStateV1;
  transition?: PriceThresholdTriggeredTransitionInputV1;
}

export interface CompletePriceEvaluationResult {
  outcome: "applied" | "duplicate";
  event?: AlertEventV1;
  outbox?: NotificationOutboxItemV1;
}

export interface FailPriceEvaluationInput {
  ownerUserId: string;
  ruleId: string;
  expectedRevision: number;
  authorizationRevision: number;
  workerId: string;
  leaseToken: string;
  leaseGeneration: number;
  stateKey: string;
  errorCode: string;
}

export interface DeferPriceEvaluationInput {
  ownerUserId: string;
  ruleId: string;
  expectedRevision: number;
  authorizationRevision: number;
  workerId: string;
  leaseToken: string;
  leaseGeneration: number;
  /** Bounded retry hint for admission pressure or the next expected candle close. */
  retryAfterSeconds?: number;
}

export interface RecoverExpiredLeasesResult {
  recovered: number;
}

export class AlertNotFoundError extends Error {}

export class AlertQuotaError extends Error {}

export class AlertCapacityError extends Error {}

export class AlertIdempotencyConflictError extends Error {}

export class AlertRevisionConflictError extends Error {}

export class AlertClaimLostError extends Error {}

export class AlertEvaluationConflictError extends Error {}
