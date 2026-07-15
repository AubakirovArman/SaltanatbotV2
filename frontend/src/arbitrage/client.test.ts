import { describe, expect, it } from "vitest";
import { parseArbitrageDepth, parseArbitrageScan, parseArbitrageStreamMessage } from "./client";

describe("arbitrage transport contract", () => {
  it("accepts a bounded typed snapshot", () => {
    expect(
      parseArbitrageScan({
        updatedAt: 1,
        stale: false,
        scannedSymbols: 1,
        estimatedTotalCostBps: 30,
        sources: healthyRouteSources(),
        opportunities: [quote()]
      }).opportunities[0].netEdgeBps
    ).toBe(70);
  });

  it("rejects malformed venue data and unbounded result sets", () => {
    const base = { updatedAt: 1, stale: false, scannedSymbols: 0, estimatedTotalCostBps: 30, sources: [], opportunities: [] };
    expect(() => parseArbitrageScan({ ...base, sources: [{ exchange: "unknown", market: "spot", ok: true }] })).toThrow(/unsupported/);
    expect(() => parseArbitrageScan({ ...base, opportunities: Array.from({ length: 2_001 }, () => ({})) })).toThrow(/at most 2000/);
    const malformedQuote = {
      id: "BTCUSDT:binance:bybit",
      symbol: "BTCUSDT",
      spotExchange: "binance",
      futuresExchange: "bybit",
      spotBid: 99,
      spotAsk: 100,
      spotAskSize: 1,
      futuresBid: 101,
      futuresAsk: 102,
      futuresBidSize: 1,
      grossSpreadBps: 100,
      estimatedTotalCostBps: 0,
      netEdgeBps: 100,
      topBookCapacityUsd: 100,
      fundingRate: 0,
      capturedAt: 1
    };
    expect(() => parseArbitrageScan({ ...base, opportunities: [malformedQuote] })).toThrow(/assetId/);
    expect(() =>
      parseArbitrageScan({
        ...base,
        sources: healthyRouteSources(),
        opportunities: [{ ...quote(), spotInstrumentId: "bybit:spot:BTCUSDT" }]
      })
    ).toThrow(/route identity/);
  });

  it("requires explicit timestamp and quality evidence instead of synthesizing freshness", () => {
    const base = { updatedAt: 1, stale: false, scannedSymbols: 1, estimatedTotalCostBps: 30, sources: healthyRouteSources() };
    const { spotExchangeTs: _spotExchangeTs, ...missingTimestamp } = quote();
    const { spotExchangeTimestampVerified: _spotExchangeTimestampVerified, ...missingTimestampEvidence } = quote();
    const { dataQuality: _dataQuality, ...missingQuality } = quote();

    expect(() => parseArbitrageScan({ ...base, opportunities: [missingTimestamp] })).toThrow(/spotExchangeTs/);
    expect(() => parseArbitrageScan({ ...base, opportunities: [missingTimestampEvidence] })).toThrow(/spotExchangeTimestampVerified/);
    expect(() => parseArbitrageScan({ ...base, opportunities: [missingQuality] })).toThrow(/dataQuality/);
  });

  it("preserves a validated instrument-identity coverage proof", () => {
    const parsed = parseArbitrageScan({
      updatedAt: 1,
      stale: false,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: healthyRouteSources(),
      opportunities: [quote()],
      identityCoverage: { complete: true, stale: false, failedSources: [] }
    });
    expect(parsed.identityCoverage).toEqual({ complete: true, stale: false, failedSources: [] });
    expect(() =>
      parseArbitrageScan({
        updatedAt: 1,
        stale: false,
        scannedSymbols: 1,
        estimatedTotalCostBps: 30,
        sources: healthyRouteSources(),
        opportunities: [quote()],
        identityCoverage: { complete: true, stale: true, failedSources: [] }
      })
    ).toThrow(/identityCoverage/);
  });

  it("derives freshness from both venue and local receipt timestamps", () => {
    const parsed = parseArbitrageScan({
      updatedAt: 5_000,
      stale: false,
      scannedSymbols: 2,
      estimatedTotalCostBps: 30,
      sources: healthyRouteSources(),
      opportunities: [
        {
          ...quote(),
          id: "exchange-skew-is-provenance",
          capturedAt: 5_000,
          spotExchangeTs: 1,
          futuresExchangeTs: 4_500,
          spotReceivedAt: 4_900,
          futuresReceivedAt: 4_900,
          quoteAgeMs: 4_999,
          legSkewMs: 4_499,
          dataQuality: "skewed"
        },
        {
          ...quote(),
          id: "receive-skew-gates-quality",
          capturedAt: 5_000,
          spotReceivedAt: 900,
          futuresReceivedAt: 4_901,
          quoteAgeMs: 4_999,
          legSkewMs: 4_001,
          dataQuality: "skewed"
        }
      ]
    });

    expect(parsed.opportunities.map((row) => [row.id, row.dataQuality, row.legSkewMs])).toEqual([
      ["exchange-skew-is-provenance", "skewed", 4_499],
      ["receive-skew-gates-quality", "skewed", 4_001]
    ]);
  });

  it("validates clock-corrected venue timestamps without raw cross-venue comparison", () => {
    const parsed = parseArbitrageScan({
      updatedAt: 100_000,
      stale: false,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: healthyRouteSources(),
      opportunities: [correctedQuote()]
    });

    expect(parsed.opportunities[0]).toMatchObject({
      dataQuality: "fresh",
      quoteAgeMs: 104,
      legSkewMs: 4,
      clockCorrection: { modelVersion: "venue-clock-v1", skewEligible: true }
    });
    expect(() =>
      parseArbitrageScan({
        updatedAt: 100_000,
        stale: false,
        scannedSymbols: 1,
        estimatedTotalCostBps: 30,
        sources: healthyRouteSources(),
        opportunities: [{ ...correctedQuote(), clockCorrection: { ...correctedQuote().clockCorrection, maximumPossibleSkewMs: 3 } }]
      })
    ).toThrow(/maximumPossibleSkewMs/);
  });

  it("requires unverified venue timestamps to be omitted rather than synthesized", () => {
    const { spotExchangeTs: _spotExchangeTs, ...withoutSpotVenueTime } = quote();
    const parsed = parseArbitrageScan({
      updatedAt: 1,
      stale: false,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: healthyRouteSources(),
      opportunities: [
        {
          ...withoutSpotVenueTime,
          spotExchangeTimestampVerified: false,
          spotReceivedAt: 0,
          quoteAgeMs: 1,
          legSkewMs: 0,
          dataQuality: "unverified"
        }
      ]
    });

    expect(parsed.opportunities[0]).toMatchObject({ spotReceivedAt: 0, quoteAgeMs: 1, dataQuality: "unverified" });
    expect(parsed.opportunities[0]).not.toHaveProperty("spotExchangeTs");
  });

  it("uses route dependencies, not an unrelated global stale bit, to gate freshness", () => {
    const independent = parseArbitrageScan({
      updatedAt: 1,
      stale: true,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: [...healthyRouteSources(), { exchange: "bybit", market: "spot", ok: false }],
      opportunities: [quote()]
    });
    const dependent = parseArbitrageScan({
      updatedAt: 1,
      stale: true,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: [
        { exchange: "binance", market: "spot", ok: false },
        { exchange: "bybit", market: "perpetual", ok: true }
      ],
      opportunities: [quote()]
    });

    expect(independent.opportunities[0].dataQuality).toBe("fresh");
    expect(dependent.opportunities[0].dataQuality).toBe("stale");
  });

  it("accepts an explicitly stale reused REST row without rejuvenating it", () => {
    const parsed = parseArbitrageScan({
      updatedAt: 1,
      stale: true,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: healthyRouteSources(),
      opportunities: [{ ...quote(), dataQuality: "stale" }]
    });
    expect(parsed.opportunities[0]).toMatchObject({ dataQuality: "stale", capturedAt: 1, quoteAgeMs: 0 });
  });

  it("accepts namespaced same-venue identity and rejects unreviewed cross-venue identity", () => {
    const sameVenue = {
      ...quote(),
      id: "CATUSDT:binance:binance",
      symbol: "CATUSDT",
      assetId: "binance:cat",
      identityScope: "venue-native",
      spotInstrumentId: "binance:spot:CATUSDT",
      futuresInstrumentId: "binance:perpetual:CATUSDT",
      futuresExchange: "binance"
    };
    const base = {
      updatedAt: 1,
      stale: false,
      scannedSymbols: 1,
      estimatedTotalCostBps: 30,
      sources: [
        { exchange: "binance", market: "spot", ok: true },
        { exchange: "binance", market: "perpetual", ok: true }
      ]
    };

    expect(parseArbitrageScan({ ...base, opportunities: [sameVenue] }).opportunities[0]).toMatchObject({
      assetId: "binance:cat",
      identityScope: "venue-native"
    });
    expect(() =>
      parseArbitrageScan({
        ...base,
        sources: healthyRouteSources(),
        opportunities: [{ ...quote(), assetId: "crypto:cat" }]
      })
    ).toThrow(/reviewed cross-venue identity/);
  });

  it("parses stream snapshots and bounded depth results", () => {
    const scan = { updatedAt: 1, stale: false, scannedSymbols: 0, estimatedTotalCostBps: 0, sources: [], opportunities: [] };
    expect(parseArbitrageStreamMessage({ type: "arbitrage_snapshot", data: scan }).type).toBe("snapshot");
    const leg = { exchange: "binance", market: "spot", side: "buy", requestedNotionalUsd: 100, filledNotionalUsd: 100, quantity: 1, averagePrice: 100, worstPrice: 100, topPrice: 100, slippageBps: 0, levelsUsed: 1, complete: true, capturedAt: 1 };
    const depth = parseArbitrageDepth({
      identityScope: "cross-venue-reviewed",
      assetId: "crypto:bitcoin",
      economicAssetId: "crypto:bitcoin",
      spotInstrumentId: "binance:spot:BTCUSDT",
      futuresInstrumentId: "bybit:perpetual:BTCUSDT",
      symbol: "BTCUSDT",
      requestedNotionalUsd: 100,
      spot: leg,
      perpetual: { ...leg, exchange: "bybit", market: "perpetual", side: "sell" },
      timing: {
        spot: { receivedAt: 1, ageMs: 2 },
        perpetual: { exchangeTs: 2, receivedAt: 2, ageMs: 1 },
        ageMs: 2,
        receiveSkewMs: 1,
        legSkewMs: 1,
        exchangeTimestampsVerified: false,
        quality: "unverified"
      },
      constraints: { metadataVerified: true, minimumsSatisfied: true, verified: true, failures: [] },
      grossSpreadBps: 10,
      complete: false,
      capturedAt: 3
    });
    expect(depth.perpetual.side).toBe("sell");
    expect(depth.matchedQuantity).toBe(1);
    expect(depth.residualDeltaQuantity).toBe(0);
    expect(depth.precisionVerified).toBe(false);
    expect(depth.timing).toMatchObject({ ageMs: 2, receiveSkewMs: 1, exchangeTimestampsVerified: false, quality: "unverified" });
    expect(() => parseArbitrageDepth({ ...depth, timing: undefined })).toThrow(/timing/);
  });
});

function quote() {
  return {
    id: "BTCUSDT:binance:bybit",
    identityScope: "cross-venue-reviewed",
    symbol: "BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    assetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 2,
    futuresBid: 101,
    futuresAsk: 102,
    futuresBidSize: 2,
    grossSpreadBps: 100,
    estimatedTotalCostBps: 30,
    netEdgeBps: 70,
    topBookCapacityUsd: 200,
    fundingRate: 0.0001,
    nextFundingTime: 2,
    spotExchangeTs: 1,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: 1,
    futuresExchangeTs: 1,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: 1,
    quoteAgeMs: 0,
    legSkewMs: 0,
    dataQuality: "fresh",
    capturedAt: 1
  };
}

function correctedQuote() {
  return {
    ...quote(),
    capturedAt: 100_000,
    spotExchangeTs: 105_000,
    futuresExchangeTs: 97_000,
    spotReceivedAt: 99_900,
    futuresReceivedAt: 99_900,
    quoteAgeMs: 104,
    legSkewMs: 4,
    clockCorrection: {
      modelVersion: "venue-clock-v1",
      spot: { sourceId: "binance:public", clockStatus: "calibrated", eligible: true, quality: "verified", offsetLowerMs: 5_100, offsetUpperMs: 5_104, ageLowerMs: 100, ageUpperMs: 104 },
      futures: { sourceId: "bybit:public", clockStatus: "calibrated", eligible: true, quality: "verified", offsetLowerMs: -2_900, offsetUpperMs: -2_896, ageLowerMs: 100, ageUpperMs: 104 },
      skewEligible: true,
      minimumPossibleSkewMs: 0,
      maximumPossibleSkewMs: 4
    }
  };
}

function healthyRouteSources() {
  return [
    { exchange: "binance", market: "spot", ok: true },
    { exchange: "bybit", market: "perpetual", ok: true }
  ];
}
