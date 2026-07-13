import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ArbitrageDepthService, walkDepth } from "../src/arbitrage/depth.js";
import { createArbitrageDepthHandler, createArbitrageHandler } from "../src/arbitrage/routes.js";
import { ArbitrageScannerService } from "../src/arbitrage/service.js";

afterEach(() => {
  // Every test owns its server and fetch implementation.
});

describe("cross-exchange arbitrage scanner", () => {
  it("compares executable spot asks with perpetual bids in both venue directions", async () => {
    const service = serviceFromFixtures();

    const scan = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });

    expect(scan.stale).toBe(false);
    expect(scan.sources.every((source) => source.ok)).toBe(true);
    expect(scan.opportunities).toHaveLength(2);
    expect(scan.opportunities[0]).toMatchObject({
      id: "BTCUSDT:binance:bybit",
      spotExchange: "binance",
      futuresExchange: "bybit",
      spotBid: 99,
      spotAsk: 100,
      futuresBid: 103,
      futuresAsk: 104,
      grossSpreadBps: 300,
      netEdgeBps: 270,
      topBookCapacityUsd: 309,
      fundingRate: -0.0002
    });
    expect(scan.opportunities[1].id).toBe("BTCUSDT:bybit:binance");
    expect(scan.opportunities[1].netEdgeBps).toBeCloseTo(69.01, 2);
  });

  it("excludes non-perpetual and non-executable rows", async () => {
    const service = serviceFromFixtures({
      binanceFunding: [{ symbol: "BTCUSDT", lastFundingRate: "", nextFundingTime: 0 }],
      bybitLinear: [{ symbol: "BTCUSDT", bid1Price: "103", bid1Size: "0", ask1Price: "104", ask1Size: "5", fundingRate: "0.0001", nextFundingTime: "2000" }]
    });

    const scan = await service.scan({ estimatedTotalCostBps: 0, minSpreadBps: -10_000, limit: 20 });

    expect(scan.opportunities).toEqual([]);
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
      fetch: async (input) => {
        if (fail) throw new Error("venue offline");
        return json(matchFixture(String(input), fixtures));
      }
    });
    const initial = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });
    fail = true;
    now = 1_500;

    const fallback = await service.scan({ estimatedTotalCostBps: 30, minSpreadBps: -1_000, limit: 20 });

    expect(initial.opportunities).toHaveLength(2);
    expect(fallback.stale).toBe(true);
    expect(fallback.opportunities).toEqual(initial.opportunities);
    expect(fallback.sources.every((source) => !source.ok)).toBe(true);
  });

  it("exposes validated public query controls over HTTP", async () => {
    const app = express();
    app.get("/api/arbitrage", createArbitrageHandler(serviceFromFixtures()));
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/arbitrage`;
    try {
      const valid = await fetch(`${base}?costBps=40&minSpreadBps=0&limit=1`);
      const body = await valid.json() as { opportunities: unknown[]; estimatedTotalCostBps: number };
      expect(valid.status).toBe(200);
      expect(valid.headers.get("cache-control")).toContain("max-age=1");
      expect(body.estimatedTotalCostBps).toBe(40);
      expect(body.opportunities).toHaveLength(1);
      expect((await fetch(`${base}?costBps=-1`)).status).toBe(400);
      expect((await fetch(`${base}?limit=501`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("walks multiple order-book levels and reports incomplete liquidity", () => {
    const buy = walkDepth("binance", "spot", "buy", [[100, 1], [101, 2]], 250, 1_000);
    const sell = walkDepth("bybit", "perpetual", "sell", [[103, 1]], 250, 1_000);
    expect(buy.complete).toBe(true);
    expect(buy.levelsUsed).toBe(2);
    expect(buy.averagePrice).toBeGreaterThan(100);
    expect(buy.slippageBps).toBeGreaterThan(0);
    expect(sell.complete).toBe(false);
    expect(sell.filledNotionalUsd).toBe(103);
  });

  it("exposes validated two-leg depth analysis", async () => {
    let depthFetches = 0;
    const service = new ArbitrageDepthService({
      now: () => 2_000,
      fetch: async (input) => {
        depthFetches += 1;
        const url = String(input);
        if (url.includes("api/v3/depth")) return json({ asks: [["100", "2"]], bids: [["99", "2"]] });
        if (url.includes("category=linear")) return json({ retCode: 0, retMsg: "OK", result: { b: [["103", "2"]], a: [["104", "2"]], ts: 2_000 } });
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
      const body = await valid.json() as { complete: boolean; grossSpreadBps: number; spot: { averagePrice: number } };
      expect(valid.status).toBe(200);
      expect(body.complete).toBe(true);
      expect(body.spot.averagePrice).toBe(100);
      expect(body.grossSpreadBps).toBe(300);
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=50`)).status).toBe(200);
      expect(depthFetches).toBe(2);
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=binance&notionalUsd=100`)).status).toBe(400);
      expect((await fetch(`${base}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=bybit&notionalUsd=1`)).status).toBe(400);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

function serviceFromFixtures(overrides: Partial<ReturnType<typeof fixtureSet>> = {}) {
  const fixtures = { ...fixtureSet(), ...overrides };
  return new ArbitrageScannerService({
    now: () => 1_000,
    fetch: async (input) => json(matchFixture(String(input), fixtures))
  });
}

function fixtureSet() {
  return {
    binanceSpot: [{ symbol: "BTCUSDT", bidPrice: "99", bidQty: "8", askPrice: "100", askQty: "10" }],
    binanceFutures: [{ symbol: "BTCUSDT", bidPrice: "102", bidQty: "5", askPrice: "103", askQty: "6" }],
    binanceFunding: [{ symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: 2_000 }],
    bybitSpot: [{ symbol: "BTCUSDT", bid1Price: "100", bid1Size: "6", ask1Price: "101", ask1Size: "4" }],
    bybitLinear: [{ symbol: "BTCUSDT", bid1Price: "103", bid1Size: "3", ask1Price: "104", ask1Size: "5", fundingRate: "-0.0002", nextFundingTime: "2000" }]
  };
}

function matchFixture(url: string, fixtures: ReturnType<typeof fixtureSet>) {
  if (url.includes("api/v3/ticker/bookTicker")) return fixtures.binanceSpot;
  if (url.includes("fapi/v1/ticker/bookTicker")) return fixtures.binanceFutures;
  if (url.includes("premiumIndex")) return fixtures.binanceFunding;
  if (url.includes("category=spot")) return { retCode: 0, retMsg: "OK", result: { list: fixtures.bybitSpot } };
  if (url.includes("category=linear")) return { retCode: 0, retMsg: "OK", result: { list: fixtures.bybitLinear } };
  throw new Error(`Unexpected URL: ${url}`);
}

function json(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}
