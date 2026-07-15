import { describe, expect, it } from "vitest";
import { parseNativeSpreadScan } from "./nativeSpreads.js";

describe("native-spread SDK contract", () => {
  it("retains instrument metadata and book provenance", () => {
    expect(parseNativeSpreadScan(fixture()).opportunities[0]).toMatchObject({
      id: "bybit:native-spread:SOLUSDT_SOL/USDT",
      status: "Trading",
      minimumPrice: -2_000,
      maximumPrice: 2_000,
      launchTime: 1_000,
      sequence: 10,
      exchangeTs: 9_990,
      matchingEngineTs: 9_988,
      receivedAt: 9_995,
      riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
    });
  });

  it.each([
    [
      "inexact identity",
      (row: ReturnType<typeof opportunity>) => {
        row.id = "bybit:native-spread:OTHER";
      },
      /id must match/
    ],
    [
      "non-trading metadata",
      (row: ReturnType<typeof opportunity>) => {
        row.status = "Settling";
      },
      /status is unsupported/
    ],
    [
      "duplicate legs",
      (row: ReturnType<typeof opportunity>) => {
        row.legs[1] = { ...row.legs[0]! };
      },
      /legs must be distinct/
    ],
    [
      "off-grid price",
      (row: ReturnType<typeof opportunity>) => {
        row.bidPrice = -1.25005;
      },
      /venue step/
    ],
    [
      "crossed book",
      (row: ReturnType<typeof opportunity>) => {
        row.askPrice = -1.3;
      },
      /bidPrice below askPrice/
    ],
    [
      "wrong width",
      (row: ReturnType<typeof opportunity>) => {
        row.bookWidth = 0.04;
      },
      /bookWidth must equal/
    ],
    [
      "inflated capacity",
      (row: ReturnType<typeof opportunity>) => {
        row.executableQuantity = 3;
      },
      /step-floored executable/
    ],
    [
      "impossible quote age",
      (row: ReturnType<typeof opportunity>) => {
        row.quoteAgeMs = 11;
      },
      /quoteAgeMs must equal/
    ],
    [
      "unknown risk",
      (row: ReturnType<typeof opportunity>) => {
        row.riskFlags[3] = "atomic-execution";
      },
      /riskFlags entry is unsupported/
    ]
  ])("rejects %s", (_name, mutate, message) => {
    const raw = fixture();
    mutate(raw.opportunities[0]!);
    expect(() => parseNativeSpreadScan(raw)).toThrow(message);
  });

  it("fails closed when aggregate counts or truncation flags drift", () => {
    const impossibleCounts = fixture();
    impossibleCounts.healthyBooks = 2;
    expect(() => parseNativeSpreadScan(impossibleCounts)).toThrow(/healthyBooks cannot exceed scannedInstruments/);

    const wrongTruncation = fixture();
    wrongTruncation.truncated = true;
    expect(() => parseNativeSpreadScan(wrongTruncation)).toThrow(/truncated is inconsistent/);
  });

  it("rejects a forged fresh age for an actually stale exchange timestamp", () => {
    const raw = fixture();
    raw.updatedAt = 20_001;
    raw.opportunities[0]!.receivedAt = 20_000;
    raw.opportunities[0]!.quoteAgeMs = 0;
    expect(() => parseNativeSpreadScan(raw)).toThrow(/quoteAgeMs must equal/);

    raw.opportunities[0]!.quoteAgeMs = 10_011;
    expect(() => parseNativeSpreadScan(raw)).toThrow(/freshness gate/);
  });
});

function opportunity() {
  return {
    id: "bybit:native-spread:SOLUSDT_SOL/USDT",
    venue: "bybit",
    symbol: "SOLUSDT_SOL/USDT",
    contractType: "FundingRateArb",
    status: "Trading",
    baseCoin: "SOL",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: 0.0001,
    minimumPrice: -2_000,
    maximumPrice: 2_000,
    quantityStep: 0.1,
    minimumQuantity: 0.1,
    maximumQuantity: 50_000,
    launchTime: 1_000,
    legs: [
      { symbol: "SOLUSDT", contractType: "LinearPerpetual" },
      { symbol: "SOLUSDT", contractType: "Spot" }
    ],
    bidPrice: -1.25,
    bidQuantity: 2,
    askPrice: -1.2,
    askQuantity: 3,
    bookWidth: 0.05,
    relativeBookWidthBps: 408.1632653061228,
    executableQuantity: 2,
    sequence: 10,
    exchangeTs: 9_990,
    matchingEngineTs: 9_988,
    receivedAt: 9_995,
    quoteAgeMs: 10,
    riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
  };
}

function fixture() {
  return {
    venue: "bybit",
    marketDataMode: "venue-native-spread-orderbook",
    executionModel: "venue-matched-multi-leg",
    readOnly: true,
    updatedAt: 10_000,
    totalInstruments: 1,
    eligibleInstruments: 1,
    scannedInstruments: 1,
    healthyBooks: 1,
    totalOpportunities: 1,
    truncated: false,
    candidateTruncated: false,
    sourceErrors: [],
    opportunities: [opportunity()]
  };
}
