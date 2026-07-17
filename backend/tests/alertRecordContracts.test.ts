import { describe, expect, it } from "vitest";
import {
  ALERT_EVENT_PAGE_SCHEMA_V1,
  ALERT_EVENT_SCHEMA_V1,
  parseAlertEventPageV1,
  parseAlertRuleListV1,
  parseAlertRuleRecordV1,
} from "@saltanatbotv2/contracts";

const at = "2026-07-17T12:00:00.000Z";
const definition = {
  schemaVersion: "alert-rule-v1",
  kind: "price-threshold",
  name: "BTC threshold",
  enabled: true,
  cooldownSeconds: 60,
  deliveryChannels: ["in-app"],
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "65000",
  crossing: "inclusive",
  repeat: "once-until-rearmed",
  researchOnly: true,
  executionPermission: false,
} as const;
const record = {
  schemaVersion: "alert-rule-record-v1",
  id: "11111111-1111-4111-8111-111111111111",
  clientId: "browser:alert-1",
  revision: 2,
  definition,
  lifecycleState: "armed",
  createdAt: at,
  updatedAt: at,
  researchOnly: true,
  executionPermission: false,
} as const;

describe("public alert rule records", () => {
  it("exposes revision and lifecycle without owner or delivery internals", () => {
    expect(parseAlertRuleRecordV1(record)).toEqual(record);
    expect(() =>
      parseAlertRuleRecordV1({
        ...record,
        ownerUserId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/unknown fields/);
    expect(() =>
      parseAlertRuleRecordV1({
        ...record,
        lifecycleState: "sending",
      }),
    ).toThrow(/unsupported/);
  });

  it("parses a bounded unique list and rejects cross-device ambiguity", () => {
    expect(
      parseAlertRuleListV1({
        schemaVersion: "alert-rule-list-v1",
        rules: [record],
        generatedAt: at,
        researchOnly: true,
        executionPermission: false,
      }),
    ).toMatchObject({ rules: [record] });
    expect(() =>
      parseAlertRuleListV1({
        schemaVersion: "alert-rule-list-v1",
        rules: [record, { ...record, id: "22222222-2222-4222-8222-222222222222" }],
        generatedAt: at,
        researchOnly: true,
        executionPermission: false,
      }),
    ).toThrow(/duplicate client IDs/);
  });

  it("strictly parses a bounded owner-forward event page", () => {
    const page = {
      schemaVersion: ALERT_EVENT_PAGE_SCHEMA_V1,
      events: [
        {
          schemaVersion: ALERT_EVENT_SCHEMA_V1,
          id: "33333333-3333-4333-8333-333333333333",
          ruleId: record.id,
          ruleRevision: 1,
          ruleKind: "price-threshold",
          eventType: "triggered",
          subjectKey: "market:binance:spot:last:BTCUSDT:1m",
          transitionKey: "a".repeat(64),
          occurredAt: at,
          summary: "BTCUSDT threshold crossed.",
          researchOnly: true,
          executionPermission: false,
        },
      ],
      nextCursor: "ZXZlbnQtY3Vyc29y",
      hasMore: false,
      generatedAt: at,
      researchOnly: true,
      executionPermission: false,
    } as const;

    expect(parseAlertEventPageV1(page)).toEqual(page);
    expect(() =>
      parseAlertEventPageV1({ ...page, nextCursor: "not+base64" }),
    ).toThrow(/nextCursor/);
    expect(() =>
      parseAlertEventPageV1({
        ...page,
        events: [...page.events, page.events[0]],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseAlertEventPageV1({ ...page, executionPermission: true }),
    ).toThrow(/research-only/);
  });
});
