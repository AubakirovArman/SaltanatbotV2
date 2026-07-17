import type { DataExchange, DataMarketType, Timeframe } from "./index.js";
/** Public, notification-only alert contracts shared by the API and browser. */
export declare const ALERT_RULE_SCHEMA_V1: "alert-rule-v1";
export declare const ALERT_EVENT_SCHEMA_V1: "alert-event-v1";
export declare const NOTIFICATION_ENVELOPE_SCHEMA_V1: "notification-envelope-v1";
export declare const NOTIFICATION_OUTBOX_SCHEMA_V1: "notification-outbox-v1";
export declare const RESEARCH_ALERT_FAMILIES_V1: readonly ["basis", "cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future", "triangular", "native-spread", "options-parity", "n-leg", "cex-dex"];
export type ResearchAlertFamilyV1 = (typeof RESEARCH_ALERT_FAMILIES_V1)[number];
export type AlertRuleKindV1 = "price-threshold" | "basis-spread" | "research-route";
export type AlertDeliveryChannelV1 = "in-app" | "telegram";
export type AlertDecimalV1 = string;
/** Calendar-month candles are excluded until the evaluator has an unambiguous month boundary. */
export type PriceAlertTimeframeV1 = Exclude<Timeframe, "1M">;
interface AlertRuleCommonV1 {
    schemaVersion: typeof ALERT_RULE_SCHEMA_V1;
    kind: AlertRuleKindV1;
    name: string;
    enabled: boolean;
    cooldownSeconds: number;
    deliveryChannels: AlertDeliveryChannelV1[];
    researchOnly: true;
    executionPermission: false;
}
export interface PriceThresholdAlertDefinitionV1 extends AlertRuleCommonV1 {
    kind: "price-threshold";
    exchange: DataExchange;
    marketType: DataMarketType;
    priceType: "last";
    symbol: string;
    timeframe: PriceAlertTimeframeV1;
    direction: "above" | "below";
    /** Canonical, positive base-10 decimal. JSON numbers are deliberately forbidden. */
    threshold: AlertDecimalV1;
    crossing: "inclusive";
    repeat: "once-until-rearmed";
}
export interface BasisSpreadAlertDefinitionV1 extends AlertRuleCommonV1 {
    kind: "basis-spread";
    symbol?: string;
    spotExchange?: DataExchange;
    futuresExchange?: DataExchange;
    minimumNetEdgeBps: AlertDecimalV1;
    minimumCapacityUsd: AlertDecimalV1;
    estimatedNonFundingCostBps: AlertDecimalV1;
    holdingHours: AlertDecimalV1;
    crossing: "ineligible-to-eligible";
}
export interface ResearchRouteAlertDefinitionV1 extends AlertRuleCommonV1 {
    kind: "research-route";
    families: ResearchAlertFamilyV1[];
    economicAssetIds: string[];
    minimumConservativeNetProfit: AlertDecimalV1;
    minimumNetEdgeBps: AlertDecimalV1;
    minimumCapacityValuation: AlertDecimalV1;
    maximumRiskCapitalValuation?: AlertDecimalV1;
    minimumEvidenceQuality: "fresh" | "verified";
    maximumObservationAgeMs: number;
    maximumEconomicsAgeMs: number;
    maximumIdentityAgeMs: number;
    crossing: "ineligible-to-eligible";
}
export type AlertRuleDocumentV1 = PriceThresholdAlertDefinitionV1 | BasisSpreadAlertDefinitionV1 | ResearchRouteAlertDefinitionV1;
export type AlertEventTypeV1 = "armed" | "rearmed" | "eligible" | "ineligible" | "triggered" | "suppressed" | "stale" | "disabled" | "error";
export interface AlertEventV1 {
    schemaVersion: typeof ALERT_EVENT_SCHEMA_V1;
    id: string;
    ruleId: string;
    ruleRevision: number;
    ruleKind: AlertRuleKindV1;
    eventType: AlertEventTypeV1;
    subjectKey: string;
    transitionKey: string;
    evidenceId?: string;
    evidenceFingerprint?: string;
    occurredAt: string;
    summary: string;
    researchOnly: true;
    executionPermission: false;
}
export type NotificationSeverityV1 = "info" | "warning" | "critical";
/** Provider-neutral message. It intentionally contains no destination or credential fields. */
export interface NotificationEnvelopeV1 {
    schemaVersion: typeof NOTIFICATION_ENVELOPE_SCHEMA_V1;
    deduplicationId: string;
    alertEventId: string;
    ruleId: string;
    ruleRevision: number;
    severity: NotificationSeverityV1;
    title: string;
    body: string;
    createdAt: string;
    researchOnly: true;
    executionPermission: false;
}
export type NotificationOutboxStatusV1 = "queued" | "sending" | "retrying" | "delivered" | "dead-letter" | "cancelled" | "held";
/** Owner-scoped public projection. Lease and destination internals are never exposed. */
export interface NotificationOutboxItemV1 {
    schemaVersion: typeof NOTIFICATION_OUTBOX_SCHEMA_V1;
    id: string;
    channel: AlertDeliveryChannelV1;
    status: NotificationOutboxStatusV1;
    attempts: number;
    maxAttempts: number;
    queuedAt: string;
    nextAttemptAt?: string;
    deliveredAt?: string;
    lastError?: string;
    envelope: NotificationEnvelopeV1;
    researchOnly: true;
    executionPermission: false;
}
export declare function parseAlertRuleDocumentV1(value: unknown): AlertRuleDocumentV1;
export declare function parsePriceThresholdAlertDefinitionV1(value: unknown): PriceThresholdAlertDefinitionV1;
export declare function parseBasisSpreadAlertDefinitionV1(value: unknown): BasisSpreadAlertDefinitionV1;
export declare function parseResearchRouteAlertDefinitionV1(value: unknown): ResearchRouteAlertDefinitionV1;
export declare function parseAlertEventV1(value: unknown): AlertEventV1;
export declare function parseNotificationEnvelopeV1(value: unknown): NotificationEnvelopeV1;
export declare function parseNotificationOutboxItemV1(value: unknown): NotificationOutboxItemV1;
export {};
