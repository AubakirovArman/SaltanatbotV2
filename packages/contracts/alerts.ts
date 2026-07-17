import type { DataExchange, DataMarketType, Timeframe } from "./index.js";
import { parseScreenerDefinitionV1, type ScreenerDefinitionV1 } from "./screener.js";

/** Public, notification-only alert contracts shared by the API and browser. */

export const ALERT_RULE_SCHEMA_V1 = "alert-rule-v1" as const;
export const ALERT_EVENT_SCHEMA_V1 = "alert-event-v1" as const;
export const NOTIFICATION_ENVELOPE_SCHEMA_V1 = "notification-envelope-v1" as const;
export const NOTIFICATION_OUTBOX_SCHEMA_V1 = "notification-outbox-v1" as const;

export const RESEARCH_ALERT_FAMILIES_V1 = [
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
  "cex-dex",
] as const;

export type ResearchAlertFamilyV1 = (typeof RESEARCH_ALERT_FAMILIES_V1)[number];
export type AlertRuleKindV1 = "price-threshold" | "basis-spread" | "research-route" | "screener";
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

/** Embeds the screen definition by value so the rule revision stays immutable. */
export interface ScreenerAlertDefinitionV1 extends AlertRuleCommonV1 {
  kind: "screener";
  screen: ScreenerDefinitionV1;
  repeat: "on-change";
}

export type AlertRuleDocumentV1 =
  | PriceThresholdAlertDefinitionV1
  | BasisSpreadAlertDefinitionV1
  | ResearchRouteAlertDefinitionV1
  | ScreenerAlertDefinitionV1;

export type AlertEventTypeV1 =
  | "armed"
  | "rearmed"
  | "eligible"
  | "ineligible"
  | "triggered"
  | "suppressed"
  | "stale"
  | "disabled"
  | "error";

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

export type NotificationOutboxStatusV1 =
  | "queued"
  | "sending"
  | "retrying"
  | "delivered"
  | "dead-letter"
  | "cancelled"
  | "held";

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

const RULE_COMMON_KEYS = [
  "schemaVersion",
  "kind",
  "name",
  "enabled",
  "cooldownSeconds",
  "deliveryChannels",
  "researchOnly",
  "executionPermission",
] as const;
const PRICE_ALERT_TIMEFRAMES = new Set<string>(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"]);
const RESEARCH_FAMILIES = new Set<string>(RESEARCH_ALERT_FAMILIES_V1);
const EVENT_TYPES = new Set<string>(["armed", "rearmed", "eligible", "ineligible", "triggered", "suppressed", "stale", "disabled", "error"]);
const OUTBOX_STATUSES = new Set<string>(["queued", "sending", "retrying", "delivered", "dead-letter", "cancelled", "held"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{1,29}$/;
const ECONOMIC_ASSET_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,95}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._\-/]{0,255}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,18})?$/;

export function parseAlertRuleDocumentV1(value: unknown): AlertRuleDocumentV1 {
  const input = object(value, "alert rule");
  const kind = input.kind;
  if (kind === "price-threshold") return parsePriceThresholdAlertDefinitionV1(input);
  if (kind === "basis-spread") return parseBasisSpreadAlertDefinitionV1(input);
  if (kind === "research-route") return parseResearchRouteAlertDefinitionV1(input);
  if (kind === "screener") return parseScreenerAlertDefinitionV1(input);
  throw new Error("alert rule.kind is unsupported");
}

export function parsePriceThresholdAlertDefinitionV1(value: unknown): PriceThresholdAlertDefinitionV1 {
  const input = object(value, "price threshold alert");
  exact(
    input,
    [...RULE_COMMON_KEYS, "exchange", "marketType", "priceType", "symbol", "timeframe", "direction", "threshold", "crossing", "repeat"],
    [],
    "price threshold alert",
  );
  const common = parseRuleCommon(input, "price-threshold", "price threshold alert");
  return {
    ...common,
    kind: "price-threshold",
    exchange: exchange(input.exchange, "price threshold alert.exchange"),
    marketType: marketType(input.marketType, "price threshold alert.marketType"),
    priceType: priceType(input.priceType, "price threshold alert.priceType"),
    symbol: symbol(input.symbol, "price threshold alert.symbol"),
    timeframe: timeframe(input.timeframe, "price threshold alert.timeframe"),
    direction: oneOf(input.direction, ["above", "below"] as const, "price threshold alert.direction"),
    threshold: decimal(input.threshold, "price threshold alert.threshold", { positive: true }),
    crossing: literal(input.crossing, "inclusive", "price threshold alert.crossing"),
    repeat: literal(input.repeat, "once-until-rearmed", "price threshold alert.repeat"),
  };
}

export function parseBasisSpreadAlertDefinitionV1(value: unknown): BasisSpreadAlertDefinitionV1 {
  const input = object(value, "basis spread alert");
  exact(
    input,
    [...RULE_COMMON_KEYS, "minimumNetEdgeBps", "minimumCapacityUsd", "estimatedNonFundingCostBps", "holdingHours", "crossing"],
    ["symbol", "spotExchange", "futuresExchange"],
    "basis spread alert",
  );
  const result: BasisSpreadAlertDefinitionV1 = {
    ...parseRuleCommon(input, "basis-spread", "basis spread alert"),
    kind: "basis-spread",
    minimumNetEdgeBps: boundedDecimal(input.minimumNetEdgeBps, "basis spread alert.minimumNetEdgeBps", -10_000, 10_000),
    minimumCapacityUsd: boundedDecimal(input.minimumCapacityUsd, "basis spread alert.minimumCapacityUsd", 0, 1_000_000_000),
    estimatedNonFundingCostBps: boundedDecimal(input.estimatedNonFundingCostBps, "basis spread alert.estimatedNonFundingCostBps", 0, 2_000),
    holdingHours: boundedDecimal(input.holdingHours, "basis spread alert.holdingHours", 0, 720),
    crossing: literal(input.crossing, "ineligible-to-eligible", "basis spread alert.crossing"),
  };
  if (input.symbol !== undefined) result.symbol = symbol(input.symbol, "basis spread alert.symbol");
  if (input.spotExchange !== undefined) result.spotExchange = exchange(input.spotExchange, "basis spread alert.spotExchange");
  if (input.futuresExchange !== undefined) result.futuresExchange = exchange(input.futuresExchange, "basis spread alert.futuresExchange");
  return result;
}

export function parseResearchRouteAlertDefinitionV1(value: unknown): ResearchRouteAlertDefinitionV1 {
  const input = object(value, "research route alert");
  exact(
    input,
    [
      ...RULE_COMMON_KEYS,
      "families",
      "economicAssetIds",
      "minimumConservativeNetProfit",
      "minimumNetEdgeBps",
      "minimumCapacityValuation",
      "minimumEvidenceQuality",
      "maximumObservationAgeMs",
      "maximumEconomicsAgeMs",
      "maximumIdentityAgeMs",
      "crossing",
    ],
    ["maximumRiskCapitalValuation"],
    "research route alert",
  );
  const families = uniqueArray(input.families, "research route alert.families", RESEARCH_ALERT_FAMILIES_V1.length, (item, label) => {
    if (typeof item !== "string" || !RESEARCH_FAMILIES.has(item)) throw new Error(`${label} is unsupported`);
    return item as ResearchAlertFamilyV1;
  });
  const economicAssetIds = uniqueArray(input.economicAssetIds, "research route alert.economicAssetIds", 64, (item, label) => pattern(item, label, ECONOMIC_ASSET_ID, 3, 128));
  const result: ResearchRouteAlertDefinitionV1 = {
    ...parseRuleCommon(input, "research-route", "research route alert"),
    kind: "research-route",
    families,
    economicAssetIds,
    minimumConservativeNetProfit: boundedDecimal(input.minimumConservativeNetProfit, "research route alert.minimumConservativeNetProfit", -1e15, 1e15),
    minimumNetEdgeBps: boundedDecimal(input.minimumNetEdgeBps, "research route alert.minimumNetEdgeBps", -10_000, 1_000_000),
    minimumCapacityValuation: boundedDecimal(input.minimumCapacityValuation, "research route alert.minimumCapacityValuation", 0, 1e15),
    minimumEvidenceQuality: oneOf(input.minimumEvidenceQuality, ["fresh", "verified"] as const, "research route alert.minimumEvidenceQuality"),
    maximumObservationAgeMs: integer(input.maximumObservationAgeMs, "research route alert.maximumObservationAgeMs", 100, 86_400_000),
    maximumEconomicsAgeMs: integer(input.maximumEconomicsAgeMs, "research route alert.maximumEconomicsAgeMs", 100, 86_400_000),
    maximumIdentityAgeMs: integer(input.maximumIdentityAgeMs, "research route alert.maximumIdentityAgeMs", 100, 90 * 86_400_000),
    crossing: literal(input.crossing, "ineligible-to-eligible", "research route alert.crossing"),
  };
  if (input.maximumRiskCapitalValuation !== undefined) {
    result.maximumRiskCapitalValuation = boundedDecimal(input.maximumRiskCapitalValuation, "research route alert.maximumRiskCapitalValuation", Number.MIN_VALUE, 1e15);
  }
  return result;
}

export function parseScreenerAlertDefinitionV1(value: unknown): ScreenerAlertDefinitionV1 {
  const input = object(value, "screener alert");
  exact(input, [...RULE_COMMON_KEYS, "screen", "repeat"], [], "screener alert");
  const common = parseRuleCommon(input, "screener", "screener alert");
  return {
    ...common,
    kind: "screener",
    screen: parseScreenerDefinitionV1(input.screen),
    repeat: literal(input.repeat, "on-change", "screener alert.repeat"),
  };
}

export function parseAlertEventV1(value: unknown): AlertEventV1 {
  const input = object(value, "alert event");
  exact(
    input,
    ["schemaVersion", "id", "ruleId", "ruleRevision", "ruleKind", "eventType", "subjectKey", "transitionKey", "occurredAt", "summary", "researchOnly", "executionPermission"],
    ["evidenceId", "evidenceFingerprint"],
    "alert event",
  );
  safety(input, ALERT_EVENT_SCHEMA_V1, "alert event");
  const eventType = input.eventType;
  if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) throw new Error("alert event.eventType is unsupported");
  const result: AlertEventV1 = {
    schemaVersion: ALERT_EVENT_SCHEMA_V1,
    id: uuid(input.id, "alert event.id"),
    ruleId: uuid(input.ruleId, "alert event.ruleId"),
    ruleRevision: integer(input.ruleRevision, "alert event.ruleRevision", 1, Number.MAX_SAFE_INTEGER),
    ruleKind: ruleKind(input.ruleKind, "alert event.ruleKind"),
    eventType: eventType as AlertEventTypeV1,
    subjectKey: pattern(input.subjectKey, "alert event.subjectKey", IDENTIFIER, 1, 256),
    transitionKey: pattern(input.transitionKey, "alert event.transitionKey", HEX_64, 64, 64),
    occurredAt: timestamp(input.occurredAt, "alert event.occurredAt"),
    summary: text(input.summary, "alert event.summary", 1, 512),
    researchOnly: true,
    executionPermission: false,
  };
  if (input.evidenceId !== undefined) result.evidenceId = pattern(input.evidenceId, "alert event.evidenceId", IDENTIFIER, 1, 256);
  if (input.evidenceFingerprint !== undefined) result.evidenceFingerprint = pattern(input.evidenceFingerprint, "alert event.evidenceFingerprint", HEX_64, 64, 64);
  return result;
}

export function parseNotificationEnvelopeV1(value: unknown): NotificationEnvelopeV1 {
  const input = object(value, "notification envelope");
  exact(
    input,
    ["schemaVersion", "deduplicationId", "alertEventId", "ruleId", "ruleRevision", "severity", "title", "body", "createdAt", "researchOnly", "executionPermission"],
    [],
    "notification envelope",
  );
  safety(input, NOTIFICATION_ENVELOPE_SCHEMA_V1, "notification envelope");
  return {
    schemaVersion: NOTIFICATION_ENVELOPE_SCHEMA_V1,
    deduplicationId: pattern(input.deduplicationId, "notification envelope.deduplicationId", IDENTIFIER, 1, 160),
    alertEventId: uuid(input.alertEventId, "notification envelope.alertEventId"),
    ruleId: uuid(input.ruleId, "notification envelope.ruleId"),
    ruleRevision: integer(input.ruleRevision, "notification envelope.ruleRevision", 1, Number.MAX_SAFE_INTEGER),
    severity: oneOf(input.severity, ["info", "warning", "critical"] as const, "notification envelope.severity"),
    title: text(input.title, "notification envelope.title", 1, 160),
    body: text(input.body, "notification envelope.body", 1, 2_000, true),
    createdAt: timestamp(input.createdAt, "notification envelope.createdAt"),
    researchOnly: true,
    executionPermission: false,
  };
}

export function parseNotificationOutboxItemV1(value: unknown): NotificationOutboxItemV1 {
  const input = object(value, "notification outbox item");
  exact(
    input,
    ["schemaVersion", "id", "channel", "status", "attempts", "maxAttempts", "queuedAt", "envelope", "researchOnly", "executionPermission"],
    ["nextAttemptAt", "deliveredAt", "lastError"],
    "notification outbox item",
  );
  safety(input, NOTIFICATION_OUTBOX_SCHEMA_V1, "notification outbox item");
  const status = input.status;
  if (typeof status !== "string" || !OUTBOX_STATUSES.has(status)) throw new Error("notification outbox item.status is unsupported");
  const attempts = integer(input.attempts, "notification outbox item.attempts", 0, 20);
  const maxAttempts = integer(input.maxAttempts, "notification outbox item.maxAttempts", 1, 20);
  if (attempts > maxAttempts) throw new Error("notification outbox item.attempts exceeds maxAttempts");
  const result: NotificationOutboxItemV1 = {
    schemaVersion: NOTIFICATION_OUTBOX_SCHEMA_V1,
    id: uuid(input.id, "notification outbox item.id"),
    channel: deliveryChannel(input.channel, "notification outbox item.channel"),
    status: status as NotificationOutboxStatusV1,
    attempts,
    maxAttempts,
    queuedAt: timestamp(input.queuedAt, "notification outbox item.queuedAt"),
    envelope: parseNotificationEnvelopeV1(input.envelope),
    researchOnly: true,
    executionPermission: false,
  };
  if (input.nextAttemptAt !== undefined) result.nextAttemptAt = timestamp(input.nextAttemptAt, "notification outbox item.nextAttemptAt");
  if (input.deliveredAt !== undefined) result.deliveredAt = timestamp(input.deliveredAt, "notification outbox item.deliveredAt");
  if (input.lastError !== undefined) result.lastError = text(input.lastError, "notification outbox item.lastError", 1, 2_048, true);
  if (result.status === "delivered" && result.deliveredAt === undefined) throw new Error("delivered notification outbox item requires deliveredAt");
  if (result.status !== "delivered" && result.deliveredAt !== undefined) throw new Error("only a delivered notification outbox item may contain deliveredAt");
  return result;
}

function parseRuleCommon(input: Record<string, unknown>, kind: AlertRuleKindV1, label: string): AlertRuleCommonV1 {
  safety(input, ALERT_RULE_SCHEMA_V1, label);
  if (input.kind !== kind) throw new Error(`${label}.kind is unsupported`);
  const deliveryChannels = uniqueArray(input.deliveryChannels, `${label}.deliveryChannels`, 2, deliveryChannel);
  if (deliveryChannels.length === 0) throw new Error(`${label}.deliveryChannels must not be empty`);
  return {
    schemaVersion: ALERT_RULE_SCHEMA_V1,
    kind,
    name: text(input.name, `${label}.name`, 1, 120),
    enabled: boolean(input.enabled, `${label}.enabled`),
    cooldownSeconds: integer(input.cooldownSeconds, `${label}.cooldownSeconds`, 0, 86_400),
    deliveryChannels,
    researchOnly: true,
    executionPermission: false,
  };
}

function safety(input: Record<string, unknown>, schemaVersion: string, label: string): void {
  if (input.schemaVersion !== schemaVersion || input.researchOnly !== true || input.executionPermission !== false) {
    throw new Error(`${label} violates its versioned research-only safety envelope`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in input));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has missing or unknown fields`);
}

function text(value: unknown, label: string, minimum: number, maximum: number, multiline = false): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a trimmed string from ${minimum} to ${maximum} characters`);
  }
  if (hasControlCharacters(value, multiline)) throw new Error(`${label} contains control characters`);
  return value;
}

function hasControlCharacters(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127) return true;
    if (code > 31) continue;
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    return true;
  }
  return false;
}

function pattern(value: unknown, label: string, expression: RegExp, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !expression.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function symbol(value: unknown, label: string): string {
  return pattern(value, label, SYMBOL, 2, 30);
}

function uuid(value: unknown, label: string): string {
  return pattern(value, label, UUID, 36, 36);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is out of bounds`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function decimal(value: unknown, label: string, options: { positive?: boolean } = {}): AlertDecimalV1 {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical base-10 decimal string`);
  if (value.startsWith("-") && decimalIsZero(value)) throw new Error(`${label} must not be negative zero`);
  if (options.positive && (value.startsWith("-") || decimalIsZero(value))) throw new Error(`${label} must be positive`);
  return value;
}

function boundedDecimal(value: unknown, label: string, minimum: number, maximum: number): AlertDecimalV1 {
  const parsed = decimal(value, label);
  const numeric = Number(parsed);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) throw new Error(`${label} is out of bounds`);
  return parsed;
}

function decimalIsZero(value: string): boolean {
  return value.replace("-", "").replace(".", "").split("").every((digit) => digit === "0");
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must equal ${expected}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function uniqueArray<T>(value: unknown, label: string, maximum: number, parse: (item: unknown, label: string) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} items`);
  const result = value.map((item, index) => parse(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function exchange(value: unknown, label: string): DataExchange {
  return oneOf(value, ["binance", "bybit"] as const, label);
}

function marketType(value: unknown, label: string): DataMarketType {
  return oneOf(value, ["spot", "linear", "inverse"] as const, label);
}

function priceType(value: unknown, label: string): "last" {
  return literal(value, "last", label);
}

function timeframe(value: unknown, label: string): PriceAlertTimeframeV1 {
  if (typeof value !== "string" || !PRICE_ALERT_TIMEFRAMES.has(value)) throw new Error(`${label} is unsupported`);
  return value as PriceAlertTimeframeV1;
}

function deliveryChannel(value: unknown, label: string): AlertDeliveryChannelV1 {
  return oneOf(value, ["in-app", "telegram"] as const, label);
}

function ruleKind(value: unknown, label: string): AlertRuleKindV1 {
  return oneOf(value, ["price-threshold", "basis-spread", "research-route", "screener"] as const, label);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be a valid UTC timestamp`);
  return value;
}
