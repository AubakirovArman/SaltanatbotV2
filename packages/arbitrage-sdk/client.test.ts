import { describe, expect, it, vi } from "vitest";
import { ArbitrageSdkError, SaltanatArbitrageClient, parseBasisScan, parsePublicVenueDepth, parsePublicVenueFunding, parsePublicVenueTopBook, parseTriangularScan } from "./index.js";

describe("public arbitrage SDK", () => {
  it("invokes the default browser fetch with globalThis as its receiver", async () => {
    const receiverAwareFetch = vi.fn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(new URL(String(input)).pathname).toBe("/api/arbitrage");
      expect(init?.method).toBe("GET");
      return Promise.resolve(json(basisFixture()));
    });
    vi.stubGlobal("fetch", receiverAwareFetch);
    try {
      const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example" });
      await expect(client.basis()).resolves.toMatchObject({ opportunities: [expect.objectContaining({ id: "BTCUSDT:binance:bybit" })] });
      expect(receiverAwareFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds bounded public queries and validates the basis response", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage");
      expect(url.searchParams.get("minCapacityUsd")).toBe("5000");
      expect(url.searchParams.get("limit")).toBe("25");
      return json(basisFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });
    const scan = await client.basis({ minCapacityUsd: 5_000, limit: 25 });
    expect(scan.opportunities[0]).toMatchObject({
      id: "BTCUSDT:binance:bybit",
      strategyKind: "cash-and-carry",
      edgeKind: "projected",
      identityScope: "cross-venue-reviewed",
      spotExchangeTs: 9_985,
      spotExchangeTimestampVerified: true,
      futuresReceivedAt: 9_997,
      dataQuality: "fresh"
    });
  });

  it("rejects malformed transport values and oversized bodies", async () => {
    const invalid = basisFixture();
    invalid.opportunities[0]!.spotAsk = Number.NaN;
    expect(() => parseBasisScan(invalid)).toThrow(/spotAsk/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], assetId: "BTC" }] })).toThrow(/assetId/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], identityScope: "ticker-match" }] })).toThrow(/identityScope/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], spotExchangeTimestampVerified: undefined }] })).toThrow(/spotExchangeTimestampVerified/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], spotExchangeTs: 0, spotExchangeTimestampVerified: true }] })).toThrow(/positive safe integer/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], identityScope: "venue-native" }] })).toThrow(/reviewed cross-venue identity/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], assetId: "crypto:cat" }] })).toThrow(/reviewed cross-venue identity/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], spotInstrumentId: "binance:spot:ETHUSDT" }] })).toThrow(/route identity/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], spotBid: 100 }] })).toThrow(/spot top book/);
    expect(() => parseBasisScan({ ...basisFixture(), opportunities: [{ ...basisFixture().opportunities[0], futuresAsk: 101 }] })).toThrow(/futures top book/);

    const sameVenue = basisFixture();
    sameVenue.opportunities[0] = {
      ...sameVenue.opportunities[0]!,
      assetId: "binance:btc",
      identityScope: "venue-native",
      id: "BTCUSDT:binance:binance",
      futuresExchange: "binance",
      futuresInstrumentId: "binance:perpetual:BTCUSDT"
    };
    sameVenue.sources.push({ exchange: "binance", market: "perpetual", ok: true });
    expect(parseBasisScan(sameVenue).opportunities[0]).toMatchObject({ assetId: "binance:btc", identityScope: "venue-native" });
    expect(() =>
      parseBasisScan({
        ...sameVenue,
        opportunities: [{ ...sameVenue.opportunities[0]!, assetId: "crypto:bitcoin" }]
      })
    ).toThrow(/same-venue identity/);

    const client = new SaltanatArbitrageClient({
      baseUrl: "https://scanner.example",
      maxPayloadBytes: 100,
      fetch: (async () => new Response("x".repeat(101), { status: 200 })) as typeof fetch
    });
    await expect(client.basis()).rejects.toMatchObject<Partial<ArbitrageSdkError>>({ kind: "validation" });
  });

  it("recomputes basis timing, economics, route identity and dependency health", () => {
    const changed = (opportunity: Record<string, unknown>, envelope: Record<string, unknown> = {}) => ({
      ...basisFixture(),
      ...envelope,
      opportunities: [{ ...basisFixture().opportunities[0]!, ...opportunity }]
    });

    for (const invalid of [
      { spotReceivedAt: 0 },
      { spotReceivedAt: 10_001, quoteAgeMs: 3, legSkewMs: 4 },
      { quoteAgeMs: 9 },
      { legSkewMs: 3 },
      { dataQuality: "stale" },
      { id: "forged-route" },
      { grossSpreadBps: 99 },
      { netEdgeBps: 71 },
      { topBookMatchedQuantity: 9 },
      { topBookCapacityUsd: 999 },
      { estimatedTotalCostBps: 31, netEdgeBps: 69, expectedNetProfitUsd: 6.9 },
      { expectedNetProfitUsd: 8 }
    ]) {
      expect(() => parseBasisScan(changed(invalid))).toThrow();
    }

    const stale = changed({
      capturedAt: 20_000,
      spotReceivedAt: 9_999,
      futuresReceivedAt: 10_000,
      quoteAgeMs: 10_015,
      legSkewMs: 2,
      dataQuality: "stale"
    });
    expect(parseBasisScan(stale).opportunities[0]?.dataQuality).toBe("stale");
    const skewed = changed({ spotReceivedAt: 6_000, futuresReceivedAt: 9_500, quoteAgeMs: 4_000, legSkewMs: 3_500, dataQuality: "skewed" });
    expect(parseBasisScan(skewed).opportunities[0]?.dataQuality).toBe("skewed");
    const cached = changed({ dataQuality: "stale" }, { stale: true });
    expect(parseBasisScan(cached).opportunities[0]?.dataQuality).toBe("stale");

    const negativeBasis = changed({
      futuresBid: 99,
      futuresAsk: 100,
      grossSpreadBps: -100,
      netEdgeBps: -130,
      topBookCapacityUsd: 1_000,
      expectedNetProfitUsd: -13
    });
    expect(parseBasisScan(negativeBasis).opportunities[0]).toMatchObject({ topBookCapacityUsd: 1_000, netEdgeBps: -130 });

    const duplicateRows = basisFixture();
    duplicateRows.totalOpportunities = 2;
    duplicateRows.opportunities.push({ ...duplicateRows.opportunities[0]! });
    expect(() => parseBasisScan(duplicateRows)).toThrow(/IDs must be unique/);
    expect(() => parseBasisScan({ ...basisFixture(), totalOpportunities: 0 })).toThrow(/totalOpportunities/);
    expect(() => parseBasisScan({ ...basisFixture(), totalOpportunities: 2, truncated: false })).toThrow(/truncated/);
    expect(() => parseBasisScan({ ...basisFixture(), totalOpportunities: 1, truncated: true })).toThrow(/truncated/);
    expect(() => parseBasisScan({ ...basisFixture(), scannedSymbols: 0 })).toThrow(/scannedSymbols/);
    expect(() => parseBasisScan({ ...basisFixture(), updatedAt: 10_001 })).toThrow(/capturedAt/);

    const duplicateSources = basisFixture();
    duplicateSources.sources.push({ ...duplicateSources.sources[0]! });
    expect(() => parseBasisScan(duplicateSources)).toThrow(/source keys must be unique/);
    expect(() => parseBasisScan({ ...basisFixture(), sources: [basisFixture().sources[0]] })).toThrow(/missing source status/);
    expect(() =>
      parseBasisScan({
        ...basisFixture(),
        stale: true,
        sources: [basisFixture().sources[0], { ...basisFixture().sources[1]!, ok: false, message: "down" }]
      })
    ).toThrow(/unhealthy source/);
    expect(() =>
      parseBasisScan({
        ...basisFixture(),
        stale: false,
        sources: [basisFixture().sources[0], { ...basisFixture().sources[1]!, ok: false, message: "down" }]
      })
    ).toThrow(/stale flag/);
  });

  it("stops reading an oversized chunked response before buffering the remaining body", async () => {
    const cancel = vi.fn(async () => undefined);
    const chunks = [new TextEncoder().encode("x".repeat(64)), new TextEncoder().encode("y".repeat(64))];
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false as const, value: chunks.shift()! }),
          cancel,
          releaseLock: vi.fn()
        })
      },
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response;
    const client = new SaltanatArbitrageClient({
      baseUrl: "https://scanner.example",
      maxPayloadBytes: 100,
      fetch: (async () => response) as typeof fetch
    });

    await expect(client.basis()).rejects.toMatchObject<Partial<ArbitrageSdkError>>({ kind: "validation" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves HTTP errors and caller cancellation", async () => {
    const failed = new SaltanatArbitrageClient({
      baseUrl: "https://scanner.example",
      fetch: (async () => json({ error: "market unavailable" }, 503)) as typeof fetch
    });
    await expect(failed.basis()).rejects.toMatchObject({ status: 503, kind: "http", message: "market unavailable" });

    const controller = new AbortController();
    controller.abort();
    await expect(failed.basis({}, controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("never exposes credential or execution methods", () => {
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: vi.fn() as unknown as typeof fetch });
    expect("placeOrder" in client).toBe(false);
    expect("setApiKey" in client).toBe(false);
  });

  it("requires explicit unique and ordered triangular wire indices", () => {
    const valid = triangularFixture();
    expect(parseTriangularScan(valid).opportunities[0]?.legs.map((leg) => leg.index)).toEqual([0, 1, 2]);

    const withoutIndex = structuredClone(valid);
    (withoutIndex.opportunities[0]!.legs[0] as Partial<{ index: number }>).index = undefined;
    const duplicate = structuredClone(valid);
    duplicate.opportunities[0]!.legs[2]!.index = 1;
    const reordered = structuredClone(valid);
    [reordered.opportunities[0]!.legs[0], reordered.opportunities[0]!.legs[1]] = [reordered.opportunities[0]!.legs[1]!, reordered.opportunities[0]!.legs[0]!];

    expect(() => parseTriangularScan(withoutIndex)).toThrow(/leg\[0\]\.index/);
    expect(() => parseTriangularScan(duplicate)).toThrow(/ordered 0,1,2/);
    expect(() => parseTriangularScan(reordered)).toThrow(/ordered 0,1,2/);
  });

  it("exposes bounded read-only public venue market data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/market-data/gate/depth");
      expect(url.searchParams.get("limit")).toBe("25");
      return json({
        readOnly: true,
        venue: "gate",
        instrumentId: "gate:spot:BTC_USDT",
        marketType: "spot",
        quantityUnit: "base",
        bids: [[99, 2, 1]],
        asks: [[100, 3]],
        sequence: 42,
        exchangeTs: 9_900,
        receivedAt: 9_950,
        complete: true
      });
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });
    await expect(client.venueDepth("GATE", { marketType: "spot", instrumentId: "gate:spot:BTC_USDT", limit: 25 })).resolves.toMatchObject({ readOnly: true, sequence: 42, bids: [[99, 2, 1]] });
  });

  it("preserves Hyperliquid top-book provenance and rejects non-executable book semantics", () => {
    expect(parsePublicVenueTopBook(hyperliquidTopBookFixture())).toEqual(hyperliquidTopBookFixture());

    for (const invalid of [{ bidSize: 0 }, { askSize: -1 }, { bid: 101 }, { ask: 100 }, { source: "" }, { executable: "true" }, { sequenceAvailable: 0 }]) {
      expect(() => parsePublicVenueTopBook({ ...hyperliquidTopBookFixture(), ...invalid })).toThrow();
    }
    expect(() => parsePublicVenueTopBook({ ...hyperliquidTopBookFixture(), readOnly: false })).toThrow(/read-only/);
  });

  it("strictly validates complete sorted uncrossed depth and preserves sequence provenance", () => {
    const valid = hyperliquidDepthFixture();
    expect(parsePublicVenueDepth(valid)).toEqual(valid);

    const invalidBooks = [
      { bids: [] },
      { asks: [] },
      {
        bids: [
          [100, 0],
          [99, 2]
        ]
      },
      {
        asks: [
          [101, -1],
          [102, 2]
        ]
      },
      {
        bids: [
          [99, 1],
          [100, 2]
        ]
      },
      {
        bids: [
          [100, 1],
          [100, 2]
        ]
      },
      {
        asks: [
          [102, 1],
          [101, 2]
        ]
      },
      {
        asks: [
          [101, 1],
          [101, 2]
        ]
      },
      {
        bids: [
          [101, 1],
          [99, 2]
        ],
        asks: [
          [101, 1],
          [102, 2]
        ]
      }
    ];
    for (const invalid of invalidBooks) {
      expect(() => parsePublicVenueDepth({ ...valid, ...invalid })).toThrow();
    }
    expect(() => parsePublicVenueDepth({ ...valid, complete: false })).toThrow(/complete/);
    expect(() => parsePublicVenueDepth({ ...valid, sequence: 0, sequenceVerified: true })).toThrow(/verified sequence/);
    expect(() => parsePublicVenueDepth({ ...valid, sequenceVerified: "false" })).toThrow(/sequenceVerified/);
  });

  it("preserves Hyperliquid funding provenance and validates its closed enums", async () => {
    const funding = hyperliquidFundingFixture();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/market-data/hyperliquid/funding");
      expect(url.searchParams.get("marketType")).toBe("perpetual");
      expect(url.searchParams.get("instrumentId")).toBe("hyperliquid:mainnet:perpetual:BTC");
      expect(url.searchParams.get("historyLimit")).toBe("25");
      return json(funding);
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });

    await expect(client.venueFunding("HYPERLIQUID", { marketType: "perpetual", instrumentId: "hyperliquid:mainnet:perpetual:BTC", historyLimit: 25 })).resolves.toEqual(funding);
    expect(parsePublicVenueFunding(funding)).toMatchObject({
      network: "mainnet",
      currentEstimateSource: "predictedFundings:HlPerp",
      timestampSource: "local-receive",
      history: [{ realizedRate: 0.00008, method: "settled-hourly" }]
    });
    expect(() => parsePublicVenueFunding({ ...funding, network: "devnet" })).toThrow(/network/);
    expect(() => parsePublicVenueFunding({ ...funding, timestampSource: "synthesized" })).toThrow(/timestampSource/);
    expect(() => parsePublicVenueFunding({ ...funding, currentEstimateSource: "" })).toThrow(/currentEstimateSource/);
    expect(() => parsePublicVenueFunding({ ...funding, marketType: "spot" })).toThrow(/marketType/);
  });

  it("preserves Hyperliquid dynamic price rules instead of inventing a static tick", async () => {
    const client = new SaltanatArbitrageClient({
      baseUrl: "https://scanner.example",
      fetch: (async () =>
        json({
          readOnly: true,
          venue: "hyperliquid",
          marketType: "spot",
          receivedAt: 10_000,
          total: 1,
          truncated: false,
          rejectedRows: [],
          instruments: [
            {
              id: "hyperliquid:mainnet:spot:@107",
              assetId: "hyperliquid:mainnet:token:1",
              venue: "hyperliquid",
              venueSymbol: "@107",
              baseAsset: "PURR",
              quoteAsset: "USDC",
              settleAsset: "USDC",
              marketType: "spot",
              contractMultiplier: 1,
              tickSize: 0,
              priceRules: { staticTickSize: false, maxSignificantFigures: 5, maxDecimals: 6, integerPricesAlwaysAllowed: true },
              quantityStep: 0.01,
              minimumQuantity: 0.01,
              minimumNotional: 10,
              status: "trading"
            }
          ]
        })) as typeof fetch
    });
    await expect(client.venueInstruments("hyperliquid", { marketType: "spot" })).resolves.toMatchObject({
      instruments: [{ tickSize: 0, priceRules: { maxSignificantFigures: 5, maxDecimals: 6 } }]
    });
  });
});

function hyperliquidTopBookFixture() {
  return {
    readOnly: true as const,
    venue: "hyperliquid",
    instrumentId: "BTC",
    marketType: "perpetual" as const,
    quantityUnit: "base" as const,
    bid: 100,
    bidSize: 2,
    ask: 101,
    askSize: 3,
    source: "l2Book",
    executable: true,
    sequenceAvailable: false,
    exchangeTs: 9_990,
    receivedAt: 10_000
  };
}

function hyperliquidDepthFixture() {
  return {
    readOnly: true as const,
    venue: "hyperliquid",
    instrumentId: "BTC",
    marketType: "perpetual" as const,
    quantityUnit: "base" as const,
    bids: [
      [100, 1, 2],
      [99, 2]
    ] as const,
    asks: [
      [101, 1],
      [102, 3, 4]
    ] as const,
    sequence: 0,
    sequenceVerified: false,
    source: "l2Book",
    exchangeTs: 9_990,
    receivedAt: 10_000,
    complete: true as const
  };
}

function hyperliquidFundingFixture() {
  return {
    readOnly: true as const,
    venue: "hyperliquid",
    marketType: "perpetual" as const,
    network: "mainnet" as const,
    instrumentId: "BTC",
    currentEstimateRate: 0.0001,
    currentEstimateSource: "predictedFundings:HlPerp",
    fundingTime: 10_000,
    nextFundingTime: 3_610_000,
    intervalMinutes: 60,
    scheduleVerified: true,
    settledRate: 0.00008,
    minimumRate: -0.04,
    maximumRate: 0.04,
    formulaType: "hourly-eighth-of-8h-formula",
    method: "predictedFundings:HlPerp",
    exchangeTs: 9_995,
    timestampSource: "local-receive" as const,
    receivedAt: 9_995,
    history: [
      {
        instrumentId: "BTC",
        fundingTime: 9_000,
        fundingRate: 0.00008,
        realizedRate: 0.00008,
        method: "settled-hourly"
      }
    ],
    sourceErrors: []
  };
}

function basisFixture() {
  return {
    updatedAt: 10_000,
    stale: false,
    scannedSymbols: 1,
    totalOpportunities: 1,
    truncated: false,
    estimatedTotalCostBps: 30,
    opportunities: [
      {
        id: "BTCUSDT:binance:bybit",
        symbol: "BTCUSDT",
        assetId: "crypto:bitcoin",
        spotInstrumentId: "binance:spot:BTCUSDT",
        futuresInstrumentId: "bybit:perpetual:BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        spotBid: 99,
        spotAsk: 100,
        spotAskSize: 10,
        futuresBid: 101,
        futuresAsk: 102,
        futuresBidSize: 10,
        grossSpreadBps: 100,
        estimatedTotalCostBps: 30,
        netEdgeBps: 70,
        topBookCapacityUsd: 1_000,
        topBookMatchedQuantity: 10,
        expectedNetProfitUsd: 7,
        fundingRate: 0.0001,
        fundingScheduleVerified: true,
        nextFundingTime: 20_000,
        fundingIntervalMinutes: 480,
        strategyKind: "cash-and-carry",
        edgeKind: "projected",
        identityScope: "cross-venue-reviewed",
        spotExchangeTs: 9_985,
        spotExchangeTimestampVerified: true,
        spotReceivedAt: 9_995,
        futuresExchangeTs: 9_987,
        futuresExchangeTimestampVerified: true,
        futuresReceivedAt: 9_997,
        quoteAgeMs: 15,
        legSkewMs: 2,
        dataQuality: "fresh",
        capturedAt: 10_000
      }
    ],
    sources: [
      { exchange: "binance", market: "spot", ok: true },
      { exchange: "bybit", market: "perpetual", ok: true }
    ]
  };
}

function triangularFixture() {
  return {
    updatedAt: 10_000,
    venue: "binance",
    startAsset: "USDT",
    requestedStartQuantity: 1_000,
    scannedMarkets: 3,
    scannedCycles: 1,
    totalOpportunities: 1,
    truncated: false,
    marketDataMode: "rest-top-book",
    snapshotSource: "rest-snapshot",
    executionStatus: "non-executable-candidate",
    sequenceVerified: false,
    opportunities: [
      {
        id: "binance:USDT-BTC-ETH-USDT",
        edgeKind: "non-executable-candidate",
        executionStatus: "non-executable-candidate",
        marketDataMode: "rest-top-book",
        sequenceVerified: false,
        venue: "binance",
        startAsset: "USDT",
        startQuantity: 1_000,
        endQuantity: 1_001,
        grossReturnBps: 30,
        netReturnBps: 10,
        limitingCapacity: { requestedStartQuantity: 1_000, executableStartQuantity: 1_000, utilizationPct: 100 },
        legs: [
          { index: 0, symbol: "BTCUSDT", side: "buy", fromAsset: "USDT", toAsset: "BTC", inputQuantity: 1_000, outputQuantity: 0.01, averagePrice: 100_000, feeBps: 7.5, levelsUsed: 1 },
          { index: 1, symbol: "ETHBTC", side: "buy", fromAsset: "BTC", toAsset: "ETH", inputQuantity: 0.01, outputQuantity: 0.25, averagePrice: 0.04, feeBps: 7.5, levelsUsed: 1 },
          { index: 2, symbol: "ETHUSDT", side: "sell", fromAsset: "ETH", toAsset: "USDT", inputQuantity: 0.25, outputQuantity: 1_001, averagePrice: 4_004, feeBps: 7.5, levelsUsed: 1 }
        ],
        timestamps: { evaluatedAt: 10_000, quoteAgeMs: 10, legSkewMs: 2, exchangeTimestampsVerified: false },
        riskFlags: ["sequential-leg-risk", "top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]
      }
    ]
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
