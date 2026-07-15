import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ArbitrageDepthService, commonQuantityStep, matchOrderBookDepth, walkDepth } from "../src/arbitrage/depth.js";
import { createArbitrageDepthHandler, createArbitrageHandler } from "../src/arbitrage/routes.js";
import { ArbitrageScannerService, refreshOpportunityQuality, sortOpportunities } from "../src/arbitrage/service.js";
import { parseBinanceBookTicker } from "../src/arbitrage/upstream/binance.js";
import { parseBybitTicker } from "../src/arbitrage/upstream/bybit.js";
import { effectiveNetEdgeBps } from "../src/arbitrage/alerts.js";
import type { RegistryInstrument } from "@saltanatbotv2/contracts";

afterEach(() => {
  // Every test owns its server and fetch implementation.
});

describe("cross-exchange arbitrage scanner", () => {
  it("compares executable spot asks with perpetual bids across same-venue and cross-venue routes", async () => {
    const service = serviceFromFixtures();

    const scan = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });

    expect(scan.stale).toBe(false);
    expect(scan.identityCoverage).toEqual({ complete: true, stale: false, failedSources: [] });
    expect(scan.sources.every((source) => source.ok)).toBe(true);
    expect(scan.opportunities).toHaveLength(4);
    expect(scan.opportunities.find((row) => row.id === "BTCUSDT:binance:bybit")).toMatchObject({
      id: "BTCUSDT:binance:bybit",
      assetId: "crypto:bitcoin",
      identityScope: "cross-venue-reviewed",
      spotExchange: "binance",
      futuresExchange: "bybit",
      spotBid: 99,
      spotAsk: 100,
      futuresBid: 103,
      futuresAsk: 104,
      grossSpreadBps: 300,
      netEdgeBps: 270,
      topBookCapacityUsd: 300,
      fundingRate: -0.0002,
      spotExchangeTimestampVerified: true,
      futuresExchangeTimestampVerified: true
    });
    expect(scan.opportunities.find((row) => row.id === "BTCUSDT:bybit:binance")?.netEdgeBps).toBeCloseTo(69.01, 2);
    expect(scan.opportunities.some((row) => row.spotExchange === row.futuresExchange)).toBe(true);
  });

  it("keeps real Binance Spot REST rows as lower-ranked unverified candidates until timestamped stream data arrives", async () => {
    const service = serviceFromFixtures({
      // The production Spot bookTicker schema has no venue time field.
      binanceSpot: [{ symbol: "BTCUSDT", bidPrice: "99", bidQty: "8", askPrice: "100", askQty: "10" }]
    });

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 });

    expect(scan.opportunities).toHaveLength(4);
    expect(scan.opportunities.slice(0, 2).every((row) => row.spotExchange === "bybit" && row.dataQuality === "fresh")).toBe(true);
    const binanceSpot = scan.opportunities.filter((row) => row.spotExchange === "binance");
    expect(binanceSpot).toHaveLength(2);
    expect(binanceSpot.every((row) => row.dataQuality === "unverified" && !row.spotExchangeTimestampVerified && row.spotExchangeTs === undefined)).toBe(true);
  });

  it("excludes non-perpetual and non-executable rows", async () => {
    const service = serviceFromFixtures({
      binanceFunding: [{ symbol: "BTCUSDT", lastFundingRate: "", nextFundingTime: 0 }],
      bybitLinear: [{ symbol: "BTCUSDT", bid1Price: "103", bid1Size: "0", ask1Price: "104", ask1Size: "5", fundingRate: "0.0001", nextFundingTime: "2000" }]
    });

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -10_000, limit: 20 });

    expect(scan.opportunities).toEqual([]);
  });

  it("rejects locked or crossed REST top books before route evaluation", async () => {
    const service = serviceFromFixtures({
      binanceSpot: [{ symbol: "BTCUSDT", bidPrice: "100", bidQty: "5", askPrice: "100", askQty: "5" }],
      binanceFutures: [{ symbol: "BTCUSDT", bidPrice: "104", bidQty: "5", askPrice: "103", askQty: "5" }],
      bybitSpot: [{ symbol: "BTCUSDT", bid1Price: "101", bid1Size: "5", ask1Price: "100", ask1Size: "5" }],
      bybitLinear: [{ symbol: "BTCUSDT", bid1Price: "104", bid1Size: "5", ask1Price: "104", ask1Size: "5", fundingRate: "0.0001", nextFundingTime: "2000" }]
    });

    await expect(service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 })).resolves.toMatchObject({ opportunities: [], scannedSymbols: 0 });
  });

  it("preserves each REST leg receipt time instead of making delayed snapshots look synchronized", async () => {
    let now = 1_000;
    const fixtures = fixtureSet();
    const pending = new Map<string, (response: Response) => void>();
    const service = new ArbitrageScannerService({
      now: () => now,
      registry: registryFixture(),
      fetch: async (input) =>
        await new Promise<Response>((resolve) => {
          pending.set(String(input), resolve);
        })
    });
    const running = service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 });
    while (pending.size < 5) await new Promise<void>((resolve) => setImmediate(resolve));

    const early = [...pending].find(([url]) => url.includes("api/v3/ticker/bookTicker"));
    expect(early).toBeDefined();
    early![1](json(matchFixture(early![0], fixtures)));
    // Let the bounded body reader finish and capture the early source time.
    for (let index = 0; index < 3; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    now = 5_001;
    for (const [url, resolve] of pending) {
      if (url === early![0]) continue;
      resolve(json(matchFixture(url, fixtures)));
    }
    const scan = await running;

    // The early Binance spot leg remains visible only as a skewed research
    // candidate. Bybit's independently received pair stays fresh and ranks first.
    expect(scan.opportunities).toHaveLength(4);
    expect(scan.opportunities.slice(0, 2).every((row) => row.spotExchange === "bybit" && row.dataQuality === "fresh")).toBe(true);
    expect(scan.opportunities.filter((row) => row.spotExchange === "binance").every((row) => row.dataQuality === "skewed" && row.legSkewMs === 4_001)).toBe(true);
  });

  it("fails closed on likely same-ticker asset collisions", async () => {
    const service = serviceFromFixtures({
      bybitSpot: [{ symbol: "CATUSDT", bid1Price: "0.00000128", bid1Size: "100000", ask1Price: "0.00000129", ask1Size: "100000" }],
      binanceFutures: [{ symbol: "CATUSDT", bidPrice: "935", bidQty: "1", askPrice: "936", askQty: "1" }],
      binanceFunding: [{ symbol: "CATUSDT", lastFundingRate: "0.0001", nextFundingTime: 2_000 }],
      binanceSpot: [],
      bybitLinear: []
    });

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -10_000, limit: 20 });

    expect(scan.opportunities).toEqual([]);
  });

  it("returns a bounded stale snapshot when all venues briefly fail", async () => {
    let now = 1_000;
    let fail = false;
    const fixtures = fixtureSet();
    const service = new ArbitrageScannerService({
      now: () => now,
      cacheTtlMs: 100,
      maxStaleMs: 5_000,
      registry: registryFixture(),
      fetch: async (input) => {
        if (fail) throw new Error("venue offline");
        return json(matchFixture(String(input), fixtures));
      }
    });
    const initial = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });
    fail = true;
    now = 1_500;

    const fallback = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });

    expect(initial.opportunities).toHaveLength(4);
    expect(fallback.stale).toBe(true);
    expect(fallback.opportunities.map((row) => row.id)).toEqual(initial.opportunities.map((row) => row.id));
    expect(initial.opportunities.every((row) => row.dataQuality === "fresh")).toBe(true);
    expect(fallback.opportunities.every((row) => row.dataQuality === "stale")).toBe(true);
    expect(fallback.opportunities.every((row) => row.capturedAt === 1_500 && row.quoteAgeMs === 500)).toBe(true);
    expect(fallback.sources.every((source) => !source.ok)).toBe(true);
  });

  it("marks a partial REST scan globally stale without downgrading an independent fresh route", async () => {
    const fixtures = catFixtureSet();
    const instruments = [depthInstrument("binance", "spot", "CATUSDT", 1, { economicAssetId: undefined }), depthInstrument("binance", "perpetual", "CATUSDT", 1, { economicAssetId: undefined })];
    const service = new ArbitrageScannerService({
      now: () => 1_000,
      registry: registryFixture(instruments),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api.bybit.com")) throw new Error("Bybit offline");
        return json(matchFixture(url, fixtures));
      }
    });

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 });

    expect(scan.stale).toBe(true);
    expect(scan.sources.filter((source) => source.exchange === "bybit").every((source) => !source.ok)).toBe(true);
    expect(scan.opportunities).toHaveLength(1);
    expect(scan.opportunities[0]).toMatchObject({ id: "CATUSDT:binance:binance", dataQuality: "fresh", identityScope: "venue-native" });
  });

  it("fails cross-venue identity closed while retaining strictly verified same-venue routes", async () => {
    const fixtures = fixtureSet();
    const fetcher = async (input: string | URL | Request) => json(matchFixture(String(input), fixtures));
    const unavailable = new ArbitrageScannerService({
      now: () => 1_000,
      fetch: fetcher,
      registry: {
        snapshot: async () => {
          throw new Error("registry offline");
        }
      }
    });
    const partial = new ArbitrageScannerService({
      now: () => 1_000,
      fetch: fetcher,
      registry: registryFixture(fixtureRegistry().filter((row) => row.marketType === "spot"))
    });
    const inconsistent = new ArbitrageScannerService({
      now: () => 1_000,
      fetch: fetcher,
      registry: registryFixture(fixtureRegistry().map((row) => (row.marketType === "perpetual" ? { ...row, economicAssetId: "crypto:ethereum" } : row)))
    });
    const unreviewed = new ArbitrageScannerService({
      now: () => 1_000,
      fetch: fetcher,
      registry: registryFixture(fixtureRegistry().map(({ economicAssetId: _economicAssetId, ...row }) => row))
    });
    const options = { estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 };

    await expect(unavailable.scan(options)).resolves.toMatchObject({ opportunities: [], scannedSymbols: 0, identityCoverage: { complete: false, stale: true, failedSources: ["registry-unavailable"] } });
    await expect(partial.scan(options)).resolves.toMatchObject({ opportunities: [], scannedSymbols: 0 });
    const inconsistentScan = await inconsistent.scan(options);
    const unreviewedScan = await unreviewed.scan(options);
    expect(inconsistentScan.opportunities).toHaveLength(2);
    expect(unreviewedScan.opportunities).toHaveLength(2);
    expect([...inconsistentScan.opportunities, ...unreviewedScan.opportunities].every((row) => row.spotExchange === row.futuresExchange && row.identityScope === "venue-native" && row.assetId === `${row.spotExchange}:btc`)).toBe(true);
  });

  it("allows unlisted CAT only within each venue under strict native registry identity", async () => {
    const instruments = (["binance", "bybit"] as const).flatMap((venue) => (["spot", "perpetual"] as const).map((market) => depthInstrument(venue, market, "CATUSDT", 1, { economicAssetId: undefined })));
    const service = serviceFromFixtures(catFixtureSet(), instruments);

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 });

    expect(scan.opportunities).toHaveLength(2);
    expect(scan.opportunities.map((row) => row.id).sort()).toEqual(["CATUSDT:binance:binance", "CATUSDT:bybit:bybit"]);
    expect(scan.opportunities.map((row) => [row.assetId, row.identityScope])).toEqual(
      expect.arrayContaining([
        ["binance:cat", "venue-native"],
        ["bybit:cat", "venue-native"]
      ])
    );
    expect(scan.opportunities.some((row) => row.spotExchange !== row.futuresExchange)).toBe(false);
  });

  it("blocks same-venue native routes on base, settlement, direction, status or quantity-model mismatch", async () => {
    const spot = depthInstrument("binance", "spot", "CATUSDT", 1, { economicAssetId: undefined });
    const perpetual = depthInstrument("binance", "perpetual", "CATUSDT", 1, { economicAssetId: undefined });
    const variants: Array<[string, RegistryInstrument]> = [
      ["base", { ...perpetual, baseAsset: "DOG" }],
      ["settlement", { ...perpetual, settleAsset: "CAT" }],
      ["direction", { ...perpetual, contractDirection: "inverse" }],
      ["status", { ...perpetual, status: "closed" }],
      ["quantity unit", { ...perpetual, quantityUnit: "contract" }],
      ["multiplier", { ...perpetual, contractMultiplier: 0.001 }]
    ];

    for (const [label, candidate] of variants) {
      const scan = await serviceFromFixtures({ ...catFixtureSet(), bybitSpot: [], bybitLinear: [] }, [spot, candidate]).scan({ estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 });
      expect(scan.opportunities, label).toEqual([]);
    }
  });

  it("falls back only to a previously identity-verified snapshot when registry refresh fails", async () => {
    let now = 1_000;
    let registryAvailable = true;
    const fixtures = fixtureSet();
    const service = new ArbitrageScannerService({
      now: () => now,
      cacheTtlMs: 100,
      maxStaleMs: 5_000,
      fetch: async (input) => json(matchFixture(String(input), fixtures)),
      registry: {
        snapshot: async () => {
          if (!registryAvailable) throw new Error("registry offline");
          const instruments = fixtureRegistry();
          return { updatedAt: now, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] };
        }
      }
    });
    const options = { estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 20 };
    const verified = await service.scan(options);
    registryAvailable = false;
    now = 1_500;

    const fallback = await service.scan(options);

    expect(verified.opportunities).toHaveLength(4);
    expect(fallback.stale).toBe(true);
    expect(fallback.opportunities.map((row) => row.id)).toEqual(verified.opportunities.map((row) => row.id));
    expect(fallback.opportunities.every((row) => row.dataQuality === "stale")).toBe(true);
    expect(fallback.opportunities.every((row) => row.capturedAt === 1_500 && row.quoteAgeMs === 500)).toBe(true);
  });

  it("exposes validated public query controls over HTTP", async () => {
    const app = express();
    app.get("/api/arbitrage", createArbitrageHandler(serviceFromFixtures()));
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/arbitrage`;
    try {
      const valid = await fetch(`${base}?costBps=40&minSpreadBps=0&limit=1`);
      const body = (await valid.json()) as { opportunities: unknown[]; estimatedTotalCostBps: number };
      expect(valid.status).toBe(200);
      expect(valid.headers.get("cache-control")).toContain("max-age=1");
      expect(body.estimatedTotalCostBps).toBe(40);
      expect(body.opportunities).toHaveLength(1);
      expect((await fetch(`${base}?costBps=-1`)).status).toBe(400);
      expect((await fetch(`${base}?limit=2001`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("walks multiple order-book levels and reports incomplete liquidity", () => {
    const buy = walkDepth(
      "binance",
      "spot",
      "buy",
      [
        [100, 1],
        [101, 2]
      ],
      250,
      1_000
    );
    const sell = walkDepth("bybit", "perpetual", "sell", [[103, 1]], 250, 1_000);
    expect(buy.complete).toBe(true);
    expect(buy.levelsUsed).toBe(2);
    expect(buy.averagePrice).toBeGreaterThan(100);
    expect(buy.slippageBps).toBeGreaterThan(0);
    expect(sell.complete).toBe(false);
    expect(sell.filledNotionalUsd).toBe(103);
  });

  it("uses one rounded base quantity for both legs and exposes depth shortfall", () => {
    const depth = matchOrderBookDepth(
      {
        symbol: "BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        notionalUsd: 250,
        spotQuantityStep: 0.01,
        perpetualQuantityStep: 0.1,
        ...depthMetadata("BTCUSDT", "binance", "bybit", 0.01, 0.1)
      },
      orderBook(
        [],
        [
          [100, 1],
          [101, 2]
        ],
        1_000
      ),
      orderBook(
        [
          [103, 1.24],
          [102, 1]
        ],
        [],
        1_000
      ),
      1_000
    );

    expect(depth.quantityStep).toBe(0.1);
    expect(depth.quantityStepSource).toBe("instrument");
    expect(depth.precisionVerified).toBe(true);
    expect(depth.matchedQuantity).toBe(2.2);
    expect(depth.spot.quantity).toBe(2.2);
    expect(depth.perpetual.quantity).toBe(2.2);
    expect(depth.residualDeltaQuantity).toBe(0);
    expect(depth.roundingDustQuantity).toBeCloseTo(0.04, 10);
    expect(depth.liquidityShortfallQuantity).toBeCloseTo(0.2, 10);
    expect(depth.complete).toBe(false);
  });

  it("walks executable exit sides for the exact open quantity", () => {
    const depth = matchOrderBookDepth(
      {
        symbol: "BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        notionalUsd: 200,
        direction: "exit",
        quantity: 2,
        spotQuantityStep: 0.01,
        perpetualQuantityStep: 0.1,
        ...depthMetadata("BTCUSDT", "binance", "bybit", 0.01, 0.1)
      },
      orderBook(
        [
          [101, 1],
          [100, 1]
        ],
        [[102, 10]],
        1_000
      ),
      orderBook(
        [[102, 10]],
        [
          [103, 1],
          [104, 1]
        ],
        1_000
      ),
      1_000
    );

    expect(depth).toMatchObject({ direction: "exit", matchedQuantity: 2, residualDeltaQuantity: 0, complete: true });
    expect(depth.spot).toMatchObject({ side: "sell", quantity: 2, averagePrice: 100.5 });
    expect(depth.perpetual).toMatchObject({ side: "buy", quantity: 2, averagePrice: 103.5 });
  });

  it("keeps the two-leg net delta within rounding tolerance across varied books and lot steps", () => {
    const stepPairs = [
      [0.001, 0.01],
      [0.002, 0.003],
      [0.0005, 0.0025],
      [0.1, 0.25],
      [1, 5]
    ] as const;
    for (let seed = 1; seed <= 100; seed += 1) {
      const [spotQuantityStep, perpetualQuantityStep] = stepPairs[seed % stepPairs.length];
      const commonStep = commonQuantityStep(spotQuantityStep, perpetualQuantityStep);
      const spotPrice = 20 + seed * 0.37;
      const perpetualPrice = spotPrice * (1.001 + (seed % 7) / 1_000);
      const requestedNotionalUsd = 50 + seed * 13.17;
      const spotBudgetQuantity = requestedNotionalUsd / spotPrice;
      const perpetualCapacity = spotBudgetQuantity * (0.35 + (seed % 9) / 10);
      const depth = matchOrderBookDepth(
        { symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", notionalUsd: requestedNotionalUsd, spotQuantityStep, perpetualQuantityStep, ...depthMetadata("BTCUSDT", "binance", "bybit", spotQuantityStep, perpetualQuantityStep) },
        orderBook([], [[spotPrice, spotBudgetQuantity * 2]], seed),
        orderBook([[perpetualPrice, perpetualCapacity]], [], seed),
        seed
      );
      const tolerance = Math.max(commonStep * 1e-9, Number.EPSILON * Math.max(1, depth.matchedQuantity) * 16);

      expect(Math.abs(depth.spot.quantity - depth.perpetual.quantity)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(depth.residualDeltaQuantity)).toBeLessThanOrEqual(tolerance);
      expect(depth.matchedQuantity).toBeLessThanOrEqual(spotBudgetQuantity + tolerance);
      expect(depth.matchedQuantity).toBeLessThanOrEqual(perpetualCapacity + tolerance);
      expect(depth.matchedQuantity / commonStep).toBeCloseTo(Math.round(depth.matchedQuantity / commonStep), 8);
    }
  });

  it("fails executable completeness on registry status, unit and minimum constraints", () => {
    const metadata = depthMetadata("BTCUSDT", "binance", "bybit", 0.01, 0.01);
    const belowMinimum = matchOrderBookDepth(
      {
        symbol: "BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        notionalUsd: 100,
        spotQuantityStep: 0.01,
        perpetualQuantityStep: 0.01,
        ...metadata,
        spotInstrument: { ...metadata.spotInstrument, minimumQuantity: 2 }
      },
      orderBook([[99, 5]], [[100, 5]], 1_000),
      orderBook([[103, 5]], [[104, 5]], 1_000),
      1_000
    );
    const incompatible = matchOrderBookDepth(
      {
        symbol: "BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        notionalUsd: 100,
        spotQuantityStep: 0.01,
        perpetualQuantityStep: 0.01,
        ...metadata,
        perpetualInstrument: { ...metadata.perpetualInstrument, status: "closed", quantityUnit: "contract", contractMultiplier: 0.001 }
      },
      orderBook([[99, 5]], [[100, 5]], 1_000),
      orderBook([[103, 5]], [[104, 5]], 1_000),
      1_000
    );

    expect(belowMinimum.complete).toBe(false);
    expect(belowMinimum.constraints).toMatchObject({ metadataVerified: true, minimumsSatisfied: false, verified: false });
    expect(belowMinimum.constraints.failures).toContain("spot-below-minimum-quantity");
    expect(incompatible.complete).toBe(false);
    expect(incompatible.constraints.failures).toEqual(expect.arrayContaining(["perpetual-instrument-not-trading", "perpetual-quantity-model-unsupported"]));
  });

  it("executes strict same-venue native metadata but rejects unreviewed cross-venue identity", () => {
    const sameVenueMetadata = {
      spotInstrument: depthInstrument("binance", "spot", "CATUSDT", 0.01, { economicAssetId: undefined }),
      perpetualInstrument: depthInstrument("binance", "perpetual", "CATUSDT", 0.01, { economicAssetId: undefined })
    };
    const sameVenue = matchOrderBookDepth(
      {
        symbol: "CATUSDT",
        spotExchange: "binance",
        futuresExchange: "binance",
        notionalUsd: 100,
        spotQuantityStep: 0.01,
        perpetualQuantityStep: 0.01,
        ...sameVenueMetadata
      },
      orderBook([[99, 5]], [[100, 5]], 1_000),
      orderBook([[103, 5]], [[104, 5]], 1_000),
      1_000
    );
    expect(sameVenue).toMatchObject({ complete: true, constraints: { metadataVerified: true, minimumsSatisfied: true, verified: true } });
    expect(() =>
      matchOrderBookDepth(
        {
          symbol: "CATUSDT",
          spotExchange: "binance",
          futuresExchange: "bybit",
          notionalUsd: 100,
          spotQuantityStep: 0.01,
          perpetualQuantityStep: 0.01,
          spotInstrument: sameVenueMetadata.spotInstrument,
          perpetualInstrument: depthInstrument("bybit", "perpetual", "CATUSDT", 0.01, { economicAssetId: "crypto:cat" })
        },
        orderBook([[99, 5]], [[100, 5]], 1_000),
        orderBook([[103, 5]], [[104, 5]], 1_000),
        1_000
      )
    ).toThrow(/reviewed economic identity/);
  });

  it("rejects unsorted, locked and crossed depth instead of silently reordering it", () => {
    const request = {
      symbol: "BTCUSDT",
      spotExchange: "binance" as const,
      futuresExchange: "bybit" as const,
      notionalUsd: 100,
      spotQuantityStep: 0.01,
      perpetualQuantityStep: 0.01,
      ...depthMetadata("BTCUSDT", "binance", "bybit", 0.01, 0.01)
    };
    const perpetual = orderBook(
      [
        [103, 5],
        [102, 5]
      ],
      [[104, 5]],
      1_000
    );

    expect(() =>
      matchOrderBookDepth(
        request,
        orderBook(
          [
            [98, 5],
            [99, 5]
          ],
          [[100, 5]],
          1_000
        ),
        perpetual,
        1_000
      )
    ).toThrow(/bids must be strictly descending/);
    expect(() =>
      matchOrderBookDepth(
        request,
        orderBook(
          [[99, 5]],
          [
            [101, 5],
            [100, 5]
          ],
          1_000
        ),
        perpetual,
        1_000
      )
    ).toThrow(/asks must be strictly ascending/);
    expect(() => matchOrderBookDepth(request, orderBook([[100, 5]], [[100, 5]], 1_000), perpetual, 1_000)).toThrow(/crossed or locked/);
  });

  it("exposes validated two-leg depth analysis", async () => {
    let depthFetches = 0;
    const service = new ArbitrageDepthService({
      now: () => 2_000,
      registry: depthRegistryFixture(),
      fetch: async (input) => {
        depthFetches += 1;
        const url = String(input);
        if (url.includes("api/v3/depth")) return json({ lastUpdateId: 11, asks: [["100", "2"]], bids: [["99", "2"]] });
        if (url.includes("fapi.binance.com/fapi/v1/depth")) return json({ lastUpdateId: 12, asks: [["104", "2"]], bids: [["103", "2"]] });
        if (url.includes("category=linear")) return json({ retCode: 0, retMsg: "OK", result: { b: [["103", "2"]], a: [["104", "2"]], ts: 2_000, seq: 22 } });
        throw new Error(`Unexpected URL: ${url}`);
      }
    });
    const app = express();
    app.get("/api/arbitrage/depth", createArbitrageDepthHandler(service));
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/arbitrage/depth`;
    try {
      const valid = await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=100`);
      const body = (await valid.json()) as {
        complete: boolean;
        grossSpreadBps: number;
        matchedQuantity: number;
        residualDeltaQuantity: number;
        precisionVerified: boolean;
        quantityStepSource: string;
        constraints: { verified: boolean; failures: string[] };
        spot: { averagePrice: number; quantity: number };
        perpetual: { quantity: number };
        timing: { ageMs: number; receiveSkewMs: number; exchangeTimestampsVerified: boolean; quality: string; spot: { receivedAt: number; sequence?: number }; perpetual: { receivedAt: number; exchangeTs?: number; sequence?: number } };
      };
      expect(valid.status).toBe(200);
      expect(body.complete).toBe(false);
      expect(body.spot.averagePrice).toBe(100);
      expect(body.grossSpreadBps).toBe(300);
      expect(body.spot.quantity).toBe(body.perpetual.quantity);
      expect(body.matchedQuantity).toBe(1);
      expect(body.residualDeltaQuantity).toBe(0);
      expect(body.precisionVerified).toBe(true);
      expect(body.quantityStepSource).toBe("instrument");
      expect(body.constraints).toMatchObject({ verified: true, failures: [] });
      expect(body.timing).toMatchObject({ ageMs: 0, receiveSkewMs: 0, exchangeTimestampsVerified: false, quality: "unverified" });
      expect(body.timing.spot).toMatchObject({ receivedAt: 2_000, sequence: 11 });
      expect(body.timing.spot).not.toHaveProperty("exchangeTs");
      expect(body.timing.perpetual).toMatchObject({ receivedAt: 2_000, exchangeTs: 2_000, sequence: 22 });
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=50`)).status).toBe(200);
      expect(depthFetches).toBe(2);
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=binance&notionalUsd=100`)).status).toBe(200);
      expect(depthFetches).toBe(3);
      const exit = await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=100&direction=exit&quantity=1`);
      expect(exit.status).toBe(200);
      expect(await exit.json()).toMatchObject({ direction: "exit", complete: false, constraints: { verified: true }, timing: { quality: "unverified", exchangeTimestampsVerified: false }, spot: { side: "sell" }, perpetual: { side: "buy" } });
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=1`)).status).toBe(400);
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=100&direction=exit`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves source book times and increases age across response and book cache hits", async () => {
    let now = 1_000;
    let fetches = 0;
    const service = new ArbitrageDepthService({
      now: () => now,
      cacheTtlMs: 5_000,
      registry: depthRegistryFixture(),
      fetch: async (input) => {
        fetches += 1;
        const url = String(input);
        if (url.includes("api/v3/depth")) return json({ E: 900, lastUpdateId: 41, asks: [["100", "5"]], bids: [["99", "5"]] });
        if (url.includes("category=linear")) return json({ retCode: 0, retMsg: "OK", result: { b: [["103", "5"]], a: [["104", "5"]], ts: 950, seq: 42 } });
        throw new Error(`Unexpected URL: ${url}`);
      }
    });
    const request = { symbol: "BTCUSDT", spotExchange: "binance" as const, futuresExchange: "bybit" as const, notionalUsd: 100 };

    const initial = await service.analyze(request);
    now = 2_500;
    const cachedResponse = await service.analyze(request);
    const cachedBooks = await service.analyze({ ...request, notionalUsd: 200 });

    expect(fetches).toBe(2);
    expect(initial.timing).toMatchObject({ ageMs: 100, receiveSkewMs: 0, exchangeSkewMs: 50, legSkewMs: 50, quality: "unverified", sequenceContinuityVerified: false });
    expect(cachedResponse.capturedAt).toBe(2_500);
    expect(cachedResponse.timing).toMatchObject({ ageMs: 1_600, spot: { receivedAt: 1_000, exchangeTs: 900, sequence: 41 }, perpetual: { receivedAt: 1_000, exchangeTs: 950, sequence: 42 } });
    expect(cachedResponse.spot.capturedAt).toBe(1_000);
    expect(cachedResponse.perpetual.capturedAt).toBe(1_000);
    expect(cachedBooks.timing).toMatchObject({ ageMs: 1_600, spot: { receivedAt: 1_000 }, perpetual: { receivedAt: 1_000 } });
  });

  it("parses direct Binance and Bybit best-price streams and merges Bybit deltas", () => {
    expect(parseBinanceBookTicker({ data: { s: "BTCUSDT", b: "99", B: "2", a: "100", A: "3", E: 2_000 } }, "spot", 2_500)).toMatchObject({ symbol: "BTCUSDT", bid: 99, ask: 100, exchangeTs: 2_000, receivedAt: 2_500, capturedAt: 2_500, exchangeTimestampVerified: true });
    const binanceWithoutVenueTime = parseBinanceBookTicker({ data: { s: "BTCUSDT", b: "99", B: "2", a: "100", A: "3" } }, "spot", 2_500);
    expect(binanceWithoutVenueTime).toMatchObject({ receivedAt: 2_500, capturedAt: 2_500, exchangeTimestampVerified: false });
    expect(binanceWithoutVenueTime).not.toHaveProperty("exchangeTs");
    expect(parseBinanceBookTicker({ data: { s: "BTCUSDT", b: "100", B: "2", a: "100", A: "3", E: 2_000 } }, "spot")).toBeUndefined();
    expect(parseBinanceBookTicker({ s: "BTCUSDT", b: "99", B: "2", a: "100", A: "3", st: 2 }, "perpetual")).toBeUndefined();
    const previous = { symbol: "BTCUSDT", bid1Price: "102", bid1Size: "4", ask1Price: "103", ask1Size: "5", fundingRate: "0.0001", nextFundingTime: "3000" };
    expect(parseBybitTicker({ topic: "tickers.BTCUSDT", type: "delta", ts: 2_000, data: { bid1Price: "102.5" } }, "perpetual", 1, previous)).toMatchObject({ symbol: "BTCUSDT", bid: 102.5, ask: 103, fundingRate: 0.0001, exchangeTimestampVerified: true });
    const bybitWithoutVenueTime = parseBybitTicker({ topic: "tickers.BTCUSDT", type: "delta", data: { bid1Price: "102.5" } }, "perpetual", 2_500, previous);
    expect(bybitWithoutVenueTime).toMatchObject({ receivedAt: 2_500, exchangeTimestampVerified: false });
    expect(bybitWithoutVenueTime).not.toHaveProperty("exchangeTs");
    expect(parseBybitTicker({ topic: "tickers.BTCUSDT", ts: 2_000, data: { bid1Price: "103" } }, "perpetual", 2_500, previous)).toBeUndefined();
  });

  it("credits expected funding receipts in persistent alert net edge", () => {
    const opportunity = {
      ...fixtureOpportunity(),
      grossSpreadBps: 100,
      fundingRate: 0.0002,
      fundingScheduleVerified: true,
      fundingIntervalMinutes: 480,
      nextFundingTime: 3_600_000
    };
    expect(effectiveNetEdgeBps(opportunity, { estimatedNonFundingCostBps: 40, holdingHours: 8 }, 0)).toBe(62);
    expect(effectiveNetEdgeBps({ ...opportunity, fundingRate: 0.0002, fundingScheduleVerified: false }, { estimatedNonFundingCostBps: 40, holdingHours: 8 }, 0)).toBe(60);
    expect(effectiveNetEdgeBps({ ...opportunity, fundingRate: -0.0002, fundingScheduleVerified: false }, { estimatedNonFundingCostBps: 40, holdingHours: 8 }, 0)).toBe(58);
    expect(effectiveNetEdgeBps({ ...opportunity, fundingRate: -0.0002, fundingScheduleVerified: false, nextFundingTime: undefined }, { estimatedNonFundingCostBps: 40, holdingHours: 8 }, 0)).toBe(58);
  });

  it("fails closed on stale or cross-leg skewed quotes", () => {
    const base = fixtureOpportunity();
    expect(refreshOpportunityQuality({ ...base, spotReceivedAt: 1, futuresReceivedAt: 1 }, 20_000).dataQuality).toBe("stale");
    expect(refreshOpportunityQuality({ ...base, spotReceivedAt: 1_000, futuresReceivedAt: 5_001 }, 6_000)).toMatchObject({ dataQuality: "skewed", legSkewMs: 4_001 });
    expect(refreshOpportunityQuality({ ...base, spotReceivedAt: 0 }, 2_000).dataQuality).toBe("unverified");
    expect(refreshOpportunityQuality({ ...base, spotExchangeTimestampVerified: false, futuresExchangeTimestampVerified: false }, 2_000)).toMatchObject({ dataQuality: "unverified", legSkewMs: 0 });
    expect(refreshOpportunityQuality({ ...base, spotExchangeTs: 1, futuresExchangeTs: 1, spotReceivedAt: 19_999, futuresReceivedAt: 19_999 }, 20_000)).toMatchObject({ dataQuality: "stale", quoteAgeMs: 19_999 });
  });

  it("ranks executable dollars ahead of headline percentage spread", () => {
    const lowCapacity = { ...fixtureOpportunity(), id: "LOW", netEdgeBps: 1_000, expectedNetProfitUsd: 1, topBookCapacityUsd: 10 };
    const liquid = { ...fixtureOpportunity(), id: "LIQUID", netEdgeBps: 50, expectedNetProfitUsd: 50, topBookCapacityUsd: 10_000 };
    const unverified = { ...fixtureOpportunity(), id: "UNVERIFIED", dataQuality: "unverified" as const, spotExchangeTimestampVerified: false, spotExchangeTs: undefined, expectedNetProfitUsd: 1_000 };
    expect(sortOpportunities([lowCapacity, liquid], "expected-profit").map((row) => row.id)).toEqual(["LIQUID", "LOW"]);
    expect(sortOpportunities([lowCapacity, liquid], "net-edge").map((row) => row.id)).toEqual(["LOW", "LIQUID"]);
    expect(sortOpportunities([unverified, liquid], "expected-profit").map((row) => row.id)).toEqual(["LIQUID", "UNVERIFIED"]);
  });
});

function fixtureOpportunity() {
  return {
    id: "BTCUSDT:binance:bybit",
    strategyKind: "cash-and-carry" as const,
    edgeKind: "projected" as const,
    identityScope: "cross-venue-reviewed" as const,
    symbol: "BTCUSDT",
    assetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    spotExchange: "binance" as const,
    futuresExchange: "bybit" as const,
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 1,
    futuresBid: 103,
    futuresAsk: 104,
    futuresBidSize: 1,
    grossSpreadBps: 300,
    estimatedTotalCostBps: 0,
    netEdgeBps: 300,
    topBookCapacityUsd: 100,
    topBookMatchedQuantity: 1,
    expectedNetProfitUsd: 3,
    fundingRate: 0,
    fundingScheduleVerified: false,
    spotExchangeTs: 1,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: 1,
    futuresExchangeTs: 1,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: 1,
    quoteAgeMs: 0,
    legSkewMs: 0,
    dataQuality: "fresh" as const,
    capturedAt: 1
  };
}

function serviceFromFixtures(overrides: Partial<ReturnType<typeof fixtureSet>> = {}, instruments: RegistryInstrument[] = fixtureRegistry()) {
  const fixtures = { ...fixtureSet(), ...overrides };
  return new ArbitrageScannerService({
    now: () => 1_000,
    registry: registryFixture(instruments),
    fetch: async (input) => json(matchFixture(String(input), fixtures))
  });
}

function registryFixture(instruments = fixtureRegistry()) {
  return {
    snapshot: async () => ({
      updatedAt: 1_000,
      instruments,
      verifiedInstruments: instruments,
      capabilities: [],
      sourceErrors: [],
      sourceStates: ["binance:spot", "binance:derivatives", "binance:funding", "bybit:spot", "bybit:linear"].map((source) => ({ source, status: "fresh" as const, checkedAt: 1_000, receivedAt: 1_000, ageMs: 0 }))
    })
  };
}

function fixtureRegistry(): RegistryInstrument[] {
  return (["binance", "bybit"] as const).flatMap((venue) =>
    (["spot", "perpetual"] as const).map((marketType) => ({
      id: `${venue}:${marketType}:BTCUSDT`,
      assetId: "BTC",
      economicAssetId: "crypto:bitcoin",
      venue,
      venueSymbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      marketType,
      ...(marketType === "perpetual" ? { contractDirection: "linear" as const, fundingIntervalMinutes: 480 } : {}),
      contractMultiplier: 1,
      quantityUnit: "base" as const,
      tickSize: 0.1,
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 5,
      status: "trading" as const
    }))
  );
}

function orderBook(bids: Array<[number, number]>, asks: Array<[number, number]>, receivedAt: number, exchangeTs = receivedAt) {
  return {
    bids,
    asks,
    receivedAt,
    exchangeTs,
    source: "websocket-reconstructed" as const,
    sequenceVerified: true,
    sequence: Math.max(1, receivedAt)
  };
}

function depthMetadata(symbol: string, spotExchange: "binance" | "bybit", futuresExchange: "binance" | "bybit", spotQuantityStep: number, perpetualQuantityStep: number) {
  return {
    spotInstrument: depthInstrument(spotExchange, "spot", symbol, spotQuantityStep),
    perpetualInstrument: depthInstrument(futuresExchange, "perpetual", symbol, perpetualQuantityStep)
  };
}

function depthRegistryFixture() {
  return {
    get: async (venue: string, marketType: "spot" | "perpetual", symbol: string) => depthInstrument(venue as "binance" | "bybit", marketType, symbol, 0.001)
  };
}

function depthInstrument(venue: "binance" | "bybit", marketType: "spot" | "perpetual", symbol: string, quantityStep: number, overrides: Partial<RegistryInstrument> = {}): RegistryInstrument {
  const baseAsset = symbol.replace(/USDT$/, "");
  return {
    id: `${venue}:${marketType}:${symbol}`,
    assetId: baseAsset,
    economicAssetId: symbol === "BTCUSDT" ? "crypto:bitcoin" : "crypto:test",
    venue,
    venueSymbol: symbol,
    baseAsset,
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.01,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional: 0.01,
    status: "trading",
    ...overrides
  };
}

function fixtureSet() {
  return {
    binanceSpot: [{ symbol: "BTCUSDT", bidPrice: "99", bidQty: "8", askPrice: "100", askQty: "10", time: 1_000 }],
    binanceFutures: [{ symbol: "BTCUSDT", bidPrice: "102", bidQty: "5", askPrice: "103", askQty: "6", time: 1_000 }],
    binanceFunding: [{ symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: 2_000 }],
    bybitSpot: [{ symbol: "BTCUSDT", bid1Price: "100", bid1Size: "6", ask1Price: "101", ask1Size: "4" }],
    bybitLinear: [{ symbol: "BTCUSDT", bid1Price: "103", bid1Size: "3", ask1Price: "104", ask1Size: "5", fundingRate: "-0.0002", nextFundingTime: "2000" }]
  };
}

function catFixtureSet(): ReturnType<typeof fixtureSet> {
  return {
    binanceSpot: [{ symbol: "CATUSDT", bidPrice: "0.99", bidQty: "20", askPrice: "1", askQty: "20", time: 1_000 }],
    binanceFutures: [{ symbol: "CATUSDT", bidPrice: "1.01", bidQty: "20", askPrice: "1.02", askQty: "20", time: 1_000 }],
    binanceFunding: [{ symbol: "CATUSDT", lastFundingRate: "0.0001", nextFundingTime: 2_000 }],
    bybitSpot: [{ symbol: "CATUSDT", bid1Price: "0.995", bid1Size: "20", ask1Price: "1.005", ask1Size: "20" }],
    bybitLinear: [{ symbol: "CATUSDT", bid1Price: "1.015", bid1Size: "20", ask1Price: "1.025", ask1Size: "20", fundingRate: "0.0001", nextFundingTime: "2000" }]
  };
}

function matchFixture(url: string, fixtures: ReturnType<typeof fixtureSet>) {
  if (url.includes("api/v3/ticker/bookTicker")) return fixtures.binanceSpot;
  if (url.includes("fapi/v1/ticker/bookTicker")) return fixtures.binanceFutures;
  if (url.includes("premiumIndex")) return fixtures.binanceFunding;
  if (url.includes("category=spot")) return { retCode: 0, retMsg: "OK", time: 1_000, result: { list: fixtures.bybitSpot } };
  if (url.includes("category=linear")) return { retCode: 0, retMsg: "OK", time: 1_000, result: { list: fixtures.bybitLinear } };
  throw new Error(`Unexpected URL: ${url}`);
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}
