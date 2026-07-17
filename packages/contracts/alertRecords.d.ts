import { type AlertEventV1, type AlertRuleDocumentV1 } from "./alerts.js";
export declare const ALERT_RULE_RECORD_SCHEMA_V1: "alert-rule-record-v1";
export declare const ALERT_RULE_LIST_SCHEMA_V1: "alert-rule-list-v1";
export declare const ALERT_EVENT_PAGE_SCHEMA_V1: "alert-event-page-v1";
export type AlertRuleLifecycleStateV1 = "armed" | "triggered" | "disabled" | "stale" | "error" | "archived";
export interface AlertRuleRecordV1 {
    schemaVersion: typeof ALERT_RULE_RECORD_SCHEMA_V1;
    id: string;
    clientId: string;
    revision: number;
    definition: AlertRuleDocumentV1;
    lifecycleState: AlertRuleLifecycleStateV1;
    createdAt: string;
    updatedAt: string;
    lastEvaluatedAt?: string;
    lastTriggeredAt?: string;
    lastErrorCode?: string;
    researchOnly: true;
    executionPermission: false;
}
export interface AlertRuleListV1 {
    schemaVersion: typeof ALERT_RULE_LIST_SCHEMA_V1;
    rules: AlertRuleRecordV1[];
    generatedAt: string;
    researchOnly: true;
    executionPermission: false;
}
export interface AlertEventPageV1 {
    schemaVersion: typeof ALERT_EVENT_PAGE_SCHEMA_V1;
    events: AlertEventV1[];
    /** Opaque, owner-bound forward watermark. Clients must not inspect it. */
    nextCursor: string;
    hasMore: boolean;
    generatedAt: string;
    researchOnly: true;
    executionPermission: false;
}
export declare function parseAlertRuleRecordV1(value: unknown): AlertRuleRecordV1;
export declare function parseAlertRuleListV1(value: unknown): AlertRuleListV1;
export declare function parseAlertEventPageV1(value: unknown): AlertEventPageV1;
