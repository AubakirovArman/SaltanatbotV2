import { describe, expect, it } from "vitest";
import {
  parseAlertEventV1,
  parseAlertRuleDocumentV1,
  parseNotificationEnvelopeV1,
  parseNotificationOutboxItemV1,
  parsePriceThresholdAlertDefinitionV1,
} from "@saltanatbotv2/contracts";

const ruleId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const outboxId = "33333333-3333-4333-8333-333333333333";
const at = "2026-07-17T12:34:56.789Z";

const common = {
  schemaVersion: "alert-rule-v1",
  name: "BTC monitoring",
  enabled: true,
  cooldownSeconds: 300,
  deliveryChannels: ["in-app", "telegram"],
  researchOnly: true,
  executionPermission: false,
} as const;

const priceRule = {
  ...common,
  kind: "price-threshold",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "65000.125",
  crossing: "inclusive",
  repeat: "once-until-rearmed",
} as const;

const envelope = {
  schemaVersion: "notification-envelope-v1",
  deduplicationId: "alert:btc:crossing:42",
  alertEventId: eventId,
  ruleId,
  ruleRevision: 2,
  severity: "warning",
  title: "BTCUSDT crossed threshold",
  body: "BTCUSDT reached 65000.125",
  createdAt: at,
  researchOnly: true,
  executionPermission: false,
} as const;

describe("shared alert contracts", () => {
  it("strictly parses a route-bound price threshold with a decimal string", () => {
    expect(parsePriceThresholdAlertDefinitionV1(priceRule)).toEqual(priceRule);
    expect(parseAlertRuleDocumentV1(priceRule)).toEqual(priceRule);

    expect(() => parseAlertRuleDocumentV1({ ...priceRule, threshold: 65000.125 })).toThrow(/decimal string/);
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, threshold: "065000" })).toThrow(/decimal string/);
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, threshold: "-0" })).toThrow(/negative zero/);
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, timeframe: "2s" })).toThrow(/timeframe.*unsupported/);
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, timeframe: "1M" })).toThrow(/timeframe.*unsupported/);
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, priceType: "mark" })).toThrow(/priceType.*last/);
    const { timeframe: _timeframe, ...missingTimeframe } = priceRule;
    expect(() => parseAlertRuleDocumentV1(missingTimeframe)).toThrow(/missing or unknown fields/);
  });

  it("parses basis and research variants without weakening the safety envelope", () => {
    const basis = {
      ...common,
      kind: "basis-spread",
      name: "Basis",
      symbol: "BTCUSDT",
      spotExchange: "binance",
      futuresExchange: "bybit",
      minimumNetEdgeBps: "25.5",
      minimumCapacityUsd: "1000",
      estimatedNonFundingCostBps: "8.25",
      holdingHours: "12",
      crossing: "ineligible-to-eligible",
    } as const;
    const research = {
      ...common,
      kind: "research-route",
      name: "Reviewed routes",
      families: ["basis", "native-spread"],
      economicAssetIds: ["crypto:bitcoin"],
      minimumConservativeNetProfit: "10.25",
      minimumNetEdgeBps: "20",
      minimumCapacityValuation: "1000",
      maximumRiskCapitalValuation: "100000",
      minimumEvidenceQuality: "verified",
      maximumObservationAgeMs: 10_000,
      maximumEconomicsAgeMs: 10_000,
      maximumIdentityAgeMs: 86_400_000,
      crossing: "ineligible-to-eligible",
    } as const;

    expect(parseAlertRuleDocumentV1(basis)).toEqual(basis);
    expect(parseAlertRuleDocumentV1(research)).toEqual(research);
    expect(() => parseAlertRuleDocumentV1({ ...research, families: ["basis", "basis"] })).toThrow(/duplicates/);
    expect(() => parseAlertRuleDocumentV1({ ...research, economicAssetIds: Array.from({ length: 65 }, (_, index) => `crypto:asset-${index}`) })).toThrow(/at most 64/);
    expect(() => parseAlertRuleDocumentV1({ ...basis, executionPermission: true })).toThrow(/safety envelope/);
    expect(() => parseAlertRuleDocumentV1({ ...basis, deliveryChannels: [] })).toThrow(/must not be empty/);
  });

  it("parses strict event, provider-neutral envelope and outbox projections", () => {
    const event = {
      schemaVersion: "alert-event-v1",
      id: eventId,
      ruleId,
      ruleRevision: 2,
      ruleKind: "price-threshold",
      eventType: "triggered",
      subjectKey: "binance:spot:last:BTCUSDT:1m",
      transitionKey: "a".repeat(64),
      evidenceId: "quote:BTCUSDT:42",
      evidenceFingerprint: "b".repeat(64),
      occurredAt: at,
      summary: "Price crossed the configured threshold",
      researchOnly: true,
      executionPermission: false,
    } as const;
    const outbox = {
      schemaVersion: "notification-outbox-v1",
      id: outboxId,
      channel: "telegram",
      status: "delivered",
      attempts: 1,
      maxAttempts: 6,
      queuedAt: at,
      deliveredAt: at,
      envelope,
      researchOnly: true,
      executionPermission: false,
    } as const;

    expect(parseAlertEventV1(event)).toEqual(event);
    expect(parseNotificationEnvelopeV1(envelope)).toEqual(envelope);
    expect(parseNotificationOutboxItemV1(outbox)).toEqual(outbox);
    expect(() => parseNotificationOutboxItemV1({ ...outbox, attempts: 7 })).toThrow(/exceeds maxAttempts/);
    expect(() => parseNotificationOutboxItemV1({ ...outbox, status: "retrying" })).toThrow(/only a delivered/);
  });

  it("rejects credential, destination and cross-tenant fields at every public boundary", () => {
    expect(() => parseAlertRuleDocumentV1({ ...priceRule, apiKey: "secret" })).toThrow(/unknown fields/);
    expect(() => parseAlertEventV1({
      schemaVersion: "alert-event-v1",
      id: eventId,
      ruleId,
      ruleRevision: 1,
      ruleKind: "price-threshold",
      eventType: "armed",
      subjectKey: "binance:spot:last:BTCUSDT:1m",
      transitionKey: "a".repeat(64),
      occurredAt: at,
      summary: "Armed",
      ownerUserId: ruleId,
      researchOnly: true,
      executionPermission: false,
    })).toThrow(/unknown fields/);
    expect(() => parseNotificationEnvelopeV1({ ...envelope, token: "secret", chatId: "123" })).toThrow(/unknown fields/);
    expect(() => parseNotificationOutboxItemV1({
      schemaVersion: "notification-outbox-v1",
      id: outboxId,
      channel: "telegram",
      status: "queued",
      attempts: 0,
      maxAttempts: 6,
      queuedAt: at,
      envelope,
      rawChatId: "123",
      researchOnly: true,
      executionPermission: false,
    })).toThrow(/unknown fields/);
  });
});
