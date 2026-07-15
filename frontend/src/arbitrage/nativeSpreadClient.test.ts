import { describe, expect, it } from "vitest";
import { parseNativeSpreadScan } from "./nativeSpreadClient";

describe("native spread API boundary", () => {
  it("preserves a complete, strictly typed read-only venue-native quote", () => {
    const scan = parseNativeSpreadScan(fixture());
    expect(scan.readOnly).toBe(true);
    expect(scan.opportunities[0]).toMatchObject({
      id: "bybit:native-spread:SOLUSDT_SOL/USDT",
      contractType: "FundingRateArb",
      status: "Trading",
      minimumPrice: -2_000,
      maximumPrice: 2_000,
      launchTime: 1_000,
      bidPrice: -1.25,
      askPrice: -1.2,
      executableQuantity: 2,
      sequence: 10,
      matchingEngineTs: 9_988,
      receivedAt: 9_995
    });
  });

  it("rejects execution-mode drift, an inexact id and duplicate legs", () => {
    expect(() => parseNativeSpreadScan({ ...fixture(), readOnly: false })).toThrow(/read-only/);

    const wrongId = fixture();
    wrongId.opportunities[0]!.id = "bybit:native-spread:OTHER";
    expect(() => parseNativeSpreadScan(wrongId)).toThrow(/id must match/);

    const duplicateLegs = fixture();
    duplicateLegs.opportunities[0]!.legs[1] = { ...duplicateLegs.opportunities[0]!.legs[0]! };
    expect(() => parseNativeSpreadScan(duplicateLegs)).toThrow(/legs must be distinct/);
  });

  it("rejects crossed, inconsistent, out-of-bounds and off-tick prices", () => {
    const crossed = fixture();
    crossed.opportunities[0]!.askPrice = -1.3;
    expect(() => parseNativeSpreadScan(crossed)).toThrow(/bidPrice below askPrice/);

    const wrongWidth = fixture();
    wrongWidth.opportunities[0]!.bookWidth = 0.04;
    expect(() => parseNativeSpreadScan(wrongWidth)).toThrow(/bookWidth must equal/);

    const outOfBounds = fixture();
    outOfBounds.opportunities[0]!.askPrice = 2_001;
    expect(() => parseNativeSpreadScan(outOfBounds)).toThrow(/instrument bounds/);

    const offTick = fixture();
    offTick.opportunities[0]!.bidPrice = -1.25005;
    expect(() => parseNativeSpreadScan(offTick)).toThrow(/venue step/);
  });

  it("requires ordered quantity bounds and the exact step-floored capacity", () => {
    const invertedBounds = fixture();
    invertedBounds.opportunities[0]!.minimumQuantity = 50_001;
    expect(() => parseNativeSpreadScan(invertedBounds)).toThrow(/minimumQuantity must not exceed/);

    const offStepBook = fixture();
    offStepBook.opportunities[0]!.bidQuantity = 2.05;
    expect(() => parseNativeSpreadScan(offStepBook)).toThrow(/bidQuantity must align/);

    const inflatedCapacity = fixture();
    inflatedCapacity.opportunities[0]!.executableQuantity = 3;
    expect(() => parseNativeSpreadScan(inflatedCapacity)).toThrow(/step-floored executable/);
  });

  it("requires coherent provenance timestamps and quote age", () => {
    const matchingAfterExchange = fixture();
    matchingAfterExchange.opportunities[0]!.matchingEngineTs = 9_991;
    expect(() => parseNativeSpreadScan(matchingAfterExchange)).toThrow(/matchingEngineTs cannot be after/);

    const futureReceive = fixture();
    futureReceive.opportunities[0]!.receivedAt = 10_001;
    expect(() => parseNativeSpreadScan(futureReceive)).toThrow(/receivedAt cannot be after/);

    const impossibleAge = fixture();
    impossibleAge.opportunities[0]!.quoteAgeMs = 11;
    expect(() => parseNativeSpreadScan(impossibleAge)).toThrow(/quoteAgeMs is inconsistent/);

    const forgedFreshness = fixture();
    forgedFreshness.updatedAt = 30_000;
    forgedFreshness.opportunities[0]!.exchangeTs = 19_999;
    forgedFreshness.opportunities[0]!.matchingEngineTs = 19_998;
    forgedFreshness.opportunities[0]!.receivedAt = 20_000;
    forgedFreshness.opportunities[0]!.quoteAgeMs = 0;
    expect(() => parseNativeSpreadScan(forgedFreshness)).toThrow(/quoteAgeMs is inconsistent|freshness gate/);
  });

  it("rejects unknown or incomplete risk flags and inconsistent aggregate counts", () => {
    const unknownFlag = fixture();
    unknownFlag.opportunities[0]!.riskFlags[3] = "atomic-execution";
    expect(() => parseNativeSpreadScan(unknownFlag)).toThrow(/riskFlags entry is unsupported/);

    const missingFlag = fixture();
    missingFlag.opportunities[0]!.riskFlags.pop();
    expect(() => parseNativeSpreadScan(missingFlag)).toThrow(/each required native-spread risk flag/);

    const impossibleCounts = fixture();
    impossibleCounts.healthyBooks = 2;
    expect(() => parseNativeSpreadScan(impossibleCounts)).toThrow(/healthyBooks cannot exceed scannedInstruments/);

    const wrongTruncation = fixture();
    wrongTruncation.truncated = true;
    expect(() => parseNativeSpreadScan(wrongTruncation)).toThrow(/truncated is inconsistent/);
  });
});

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
    opportunities: [
      {
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
      }
    ]
  };
}
