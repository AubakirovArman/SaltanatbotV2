import { describe, expect, it } from "vitest";
import {
  parseCreateScreenerPresetRequest,
  parseScreenerPageLimit,
  parseScreenerPresetRevisionRequest,
  parseScreenerRunJobRequest,
  parseUpdateScreenerPresetRequest,
  SCREENER_REQUEST_BODY_BYTE_LIMIT
} from "../src/screener/apiSchema.js";

const definition = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Momentum screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 50,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [
    { kind: "rsi", period: 14, condition: "above", value: "55" },
    { kind: "quote-volume-24h", min: "1000000" }
  ],
  researchOnly: true,
  executionPermission: false
};

const runRequest = {
  schemaVersion: "screener-run-request-v1",
  definition,
  researchOnly: true,
  executionPermission: false
};

describe("canonical screener API input", () => {
  it("binds a strict definition to one stable client identifier", () => {
    expect(
      parseCreateScreenerPresetRequest({
        clientId: "browser.screener-01",
        definition
      })
    ).toEqual({ clientId: "browser.screener-01", definition });

    expect(() =>
      parseCreateScreenerPresetRequest({
        clientId: "browser.screener-01",
        definition,
        ownerUserId: "00000000-0000-4000-8000-000000000001"
      })
    ).toThrow(/missing or unknown fields/);
    expect(() =>
      parseCreateScreenerPresetRequest({
        clientId: "../other-owner",
        definition
      })
    ).toThrow(/clientId is invalid/);
    expect(() =>
      parseCreateScreenerPresetRequest({
        clientId: "browser.screener-01",
        definition: { ...definition, filters: [] }
      })
    ).toThrow(/1 to 12 filters/);
  });

  it("requires optimistic revisions for update and archive", () => {
    expect(
      parseUpdateScreenerPresetRequest({
        expectedRevision: 4,
        definition
      })
    ).toEqual({ expectedRevision: 4, definition });
    expect(parseScreenerPresetRevisionRequest({ expectedRevision: 4 })).toEqual({
      expectedRevision: 4
    });

    expect(() =>
      parseUpdateScreenerPresetRequest({
        expectedRevision: 0,
        definition
      })
    ).toThrow(/positive safe integer/);
    expect(() =>
      parseUpdateScreenerPresetRequest({
        expectedRevision: 1.5,
        definition
      })
    ).toThrow(/positive safe integer/);
    expect(() =>
      parseScreenerPresetRevisionRequest({
        expectedRevision: 4,
        force: true
      })
    ).toThrow(/missing or unknown fields/);
  });

  it("accepts only complete screener run job envelopes", () => {
    expect(
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "screener.run-0001",
        request: runRequest
      })
    ).toEqual({ clientRequestId: "screener.run-0001", request: runRequest });
    expect(
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "a".repeat(128),
        request: {
          schemaVersion: "screener-run-request-v1",
          presetId: "00000000-0000-4000-8000-000000000011",
          researchOnly: true,
          executionPermission: false
        }
      }).clientRequestId
    ).toBe("a".repeat(128));

    expect(() =>
      parseScreenerRunJobRequest({
        kind: "backtest",
        clientRequestId: "screener.run-0001",
        request: runRequest
      })
    ).toThrow(/kind must equal screener/);
    expect(() =>
      parseScreenerRunJobRequest({
        clientRequestId: "screener.run-0001",
        request: runRequest
      })
    ).toThrow(/missing or unknown fields/);
    expect(() =>
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "1234567",
        request: runRequest
      })
    ).toThrow(/clientRequestId is invalid/);
    expect(() =>
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "a".repeat(129),
        request: runRequest
      })
    ).toThrow(/clientRequestId is invalid/);
    expect(() =>
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "screener.run-0001",
        request: {
          ...runRequest,
          presetId: "00000000-0000-4000-8000-000000000011"
        }
      })
    ).toThrow(/exactly one of definition or presetId/);
    expect(() =>
      parseScreenerRunJobRequest({
        kind: "screener",
        clientRequestId: "screener.run-0001",
        request: {
          schemaVersion: "screener-run-request-v1",
          researchOnly: true,
          executionPermission: false
        }
      })
    ).toThrow(/exactly one of definition or presetId/);
  });

  it("bounds preset list pagination before a database query is allocated", () => {
    expect(SCREENER_REQUEST_BODY_BYTE_LIMIT).toBe(32_768);
    expect(parseScreenerPageLimit(undefined)).toBe(100);
    expect(parseScreenerPageLimit("")).toBe(100);
    expect(parseScreenerPageLimit("50")).toBe(50);
    expect(parseScreenerPageLimit(25)).toBe(25);
    expect(() => parseScreenerPageLimit("0")).toThrow(/between 1 and 100/);
    expect(() => parseScreenerPageLimit("101")).toThrow(/between 1 and 100/);
    expect(() => parseScreenerPageLimit("1.5")).toThrow(/between 1 and 100/);
    expect(() => parseScreenerPageLimit(["10", "20"])).toThrow(/between 1 and 100/);
  });
});
