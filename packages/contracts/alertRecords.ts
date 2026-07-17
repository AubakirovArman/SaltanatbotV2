import {
  ALERT_RULE_SCHEMA_V1,
  parseAlertEventV1,
  parseAlertRuleDocumentV1,
  type AlertEventV1,
  type AlertRuleDocumentV1,
} from "./alerts.js";

export const ALERT_RULE_RECORD_SCHEMA_V1 = "alert-rule-record-v1" as const;
export const ALERT_RULE_LIST_SCHEMA_V1 = "alert-rule-list-v1" as const;
export const ALERT_EVENT_PAGE_SCHEMA_V1 = "alert-event-page-v1" as const;

export type AlertRuleLifecycleStateV1 =
  | "armed"
  | "triggered"
  | "disabled"
  | "stale"
  | "error"
  | "archived";

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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ERROR_CODE = /^[a-z][a-z0-9._-]{0,95}$/;
const OPAQUE_CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const LIFECYCLE_STATES = new Set<string>([
  "armed",
  "triggered",
  "disabled",
  "stale",
  "error",
  "archived",
]);

export function parseAlertRuleRecordV1(value: unknown): AlertRuleRecordV1 {
  const input = exactObject(
    value,
    [
      "schemaVersion",
      "id",
      "clientId",
      "revision",
      "definition",
      "lifecycleState",
      "createdAt",
      "updatedAt",
      "researchOnly",
      "executionPermission",
    ],
    ["lastEvaluatedAt", "lastTriggeredAt", "lastErrorCode"],
    "alert rule record",
  );
  safety(input, ALERT_RULE_RECORD_SCHEMA_V1, "alert rule record");
  if (
    typeof input.lifecycleState !== "string" ||
    !LIFECYCLE_STATES.has(input.lifecycleState)
  ) {
    throw new Error("alert rule record.lifecycleState is unsupported");
  }
  const definition = parseAlertRuleDocumentV1(input.definition);
  if (definition.schemaVersion !== ALERT_RULE_SCHEMA_V1) {
    throw new Error("alert rule record definition version is invalid");
  }
  const createdAt = timestamp(input.createdAt, "alert rule record.createdAt");
  const updatedAt = timestamp(input.updatedAt, "alert rule record.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("alert rule record.updatedAt precedes createdAt");
  }
  const result: AlertRuleRecordV1 = {
    schemaVersion: ALERT_RULE_RECORD_SCHEMA_V1,
    id: pattern(input.id, UUID, "alert rule record.id"),
    clientId: pattern(
      input.clientId,
      CLIENT_ID,
      "alert rule record.clientId",
    ),
    revision: positiveInteger(
      input.revision,
      "alert rule record.revision",
    ),
    definition,
    lifecycleState: input.lifecycleState as AlertRuleLifecycleStateV1,
    createdAt,
    updatedAt,
    researchOnly: true,
    executionPermission: false,
  };
  if (input.lastEvaluatedAt !== undefined) {
    result.lastEvaluatedAt = timestamp(
      input.lastEvaluatedAt,
      "alert rule record.lastEvaluatedAt",
    );
  }
  if (input.lastTriggeredAt !== undefined) {
    result.lastTriggeredAt = timestamp(
      input.lastTriggeredAt,
      "alert rule record.lastTriggeredAt",
    );
  }
  if (input.lastErrorCode !== undefined) {
    result.lastErrorCode = pattern(
      input.lastErrorCode,
      ERROR_CODE,
      "alert rule record.lastErrorCode",
    );
  }
  return result;
}

export function parseAlertRuleListV1(value: unknown): AlertRuleListV1 {
  const input = exactObject(
    value,
    [
      "schemaVersion",
      "rules",
      "generatedAt",
      "researchOnly",
      "executionPermission",
    ],
    [],
    "alert rule list",
  );
  safety(input, ALERT_RULE_LIST_SCHEMA_V1, "alert rule list");
  if (!Array.isArray(input.rules) || input.rules.length > 200) {
    throw new Error("alert rule list.rules must contain at most 200 items");
  }
  const rules = input.rules.map(parseAlertRuleRecordV1);
  if (new Set(rules.map(({ id }) => id)).size !== rules.length) {
    throw new Error("alert rule list contains duplicate rule IDs");
  }
  if (
    new Set(rules.map(({ clientId }) => clientId)).size !== rules.length
  ) {
    throw new Error("alert rule list contains duplicate client IDs");
  }
  return {
    schemaVersion: ALERT_RULE_LIST_SCHEMA_V1,
    rules,
    generatedAt: timestamp(
      input.generatedAt,
      "alert rule list.generatedAt",
    ),
    researchOnly: true,
    executionPermission: false,
  };
}

export function parseAlertEventPageV1(value: unknown): AlertEventPageV1 {
  const input = exactObject(
    value,
    [
      "schemaVersion",
      "events",
      "nextCursor",
      "hasMore",
      "generatedAt",
      "researchOnly",
      "executionPermission",
    ],
    [],
    "alert event page",
  );
  safety(input, ALERT_EVENT_PAGE_SCHEMA_V1, "alert event page");
  if (!Array.isArray(input.events) || input.events.length > 200) {
    throw new Error("alert event page.events must contain at most 200 items");
  }
  const events = input.events.map(parseAlertEventV1);
  if (new Set(events.map(({ id }) => id)).size !== events.length) {
    throw new Error("alert event page contains duplicate event IDs");
  }
  if (typeof input.hasMore !== "boolean") {
    throw new Error("alert event page.hasMore must be boolean");
  }
  return {
    schemaVersion: ALERT_EVENT_PAGE_SCHEMA_V1,
    events,
    nextCursor: pattern(
      input.nextCursor,
      OPAQUE_CURSOR,
      "alert event page.nextCursor",
    ),
    hasMore: input.hasMore,
    generatedAt: timestamp(
      input.generatedAt,
      "alert event page.generatedAt",
    ),
    researchOnly: true,
    executionPermission: false,
  };
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return input;
}

function safety(
  input: Record<string, unknown>,
  schemaVersion: string,
  label: string,
): void {
  if (
    input.schemaVersion !== schemaVersion ||
    input.researchOnly !== true ||
    input.executionPermission !== false
  ) {
    throw new Error(`${label} violates its research-only safety envelope`);
  }
}

function pattern(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a valid UTC timestamp`);
  }
  return value;
}
