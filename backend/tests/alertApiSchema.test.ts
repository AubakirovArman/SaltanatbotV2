import { describe, expect, it } from "vitest";
import {
  parseAlertIdempotencyKey,
  parseAlertPageLimit,
  parseAlertRuleRevisionRequest,
  parseCreateAlertRuleRequest,
  parseUpdateAlertRuleRequest,
} from "../src/alerts/apiSchema.js";

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
  threshold: "65000.25",
  crossing: "inclusive",
  repeat: "once-until-rearmed",
  researchOnly: true,
  executionPermission: false,
} as const;

describe("canonical alert API input", () => {
  it("binds a strict definition to one stable client identifier", () => {
    expect(
      parseCreateAlertRuleRequest({
        clientId: "browser.alert-01",
        definition,
      }),
    ).toEqual({ clientId: "browser.alert-01", definition });

    expect(() =>
      parseCreateAlertRuleRequest({
        clientId: "browser.alert-01",
        definition,
        ownerUserId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/unknown fields/);
    expect(() =>
      parseCreateAlertRuleRequest({
        clientId: "../other-owner",
        definition,
      }),
    ).toThrow(/clientId is invalid/);
  });

  it("requires optimistic revisions for update, archive and re-arm", () => {
    expect(
      parseUpdateAlertRuleRequest({
        expectedRevision: 4,
        definition: { ...definition, threshold: "66000" },
      }),
    ).toMatchObject({
      expectedRevision: 4,
      definition: { threshold: "66000" },
    });
    expect(parseAlertRuleRevisionRequest({ expectedRevision: 4 })).toEqual({
      expectedRevision: 4,
    });
    expect(() =>
      parseUpdateAlertRuleRequest({
        expectedRevision: 0,
        definition,
      }),
    ).toThrow(/positive safe integer/);
    expect(() =>
      parseAlertRuleRevisionRequest({
        expectedRevision: 4,
        force: true,
      }),
    ).toThrow(/unknown fields/);
  });

  it("accepts one bounded idempotency key and rejects ambiguous headers", () => {
    expect(parseAlertIdempotencyKey("alert.create:01")).toBe(
      "alert.create:01",
    );
    expect(() => parseAlertIdempotencyKey(undefined)).toThrow(/invalid/);
    expect(() =>
      parseAlertIdempotencyKey(["alert.create:01", "alert.create:02"]),
    ).toThrow(/exactly one/);
    expect(() => parseAlertIdempotencyKey("contains whitespace")).toThrow(
      /invalid/,
    );
  });

  it("bounds history pagination before a database query is allocated", () => {
    expect(parseAlertPageLimit(undefined)).toBe(100);
    expect(parseAlertPageLimit("500")).toBe(500);
    expect(() => parseAlertPageLimit("0")).toThrow(/between 1 and 500/);
    expect(() => parseAlertPageLimit("501")).toThrow(/between 1 and 500/);
    expect(() => parseAlertPageLimit("1.5")).toThrow(/between 1 and 500/);
  });
});
