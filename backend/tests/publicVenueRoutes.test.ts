import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAbortableWork } from "../src/arbitrage/sharedAbortableWork.js";
import { createPublicVenueRouter } from "../src/venues/publicRoutes.js";
import { PublicVenueAdapterError, type PublicVenueAdapter } from "../src/venues/publicTypes.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("public venue market-data routes", () => {
  it("filters and bounds read-only instrument snapshots", async () => {
    const adapter = fixtureAdapter();
    const response = await request(adapter, "/gate/instruments?marketType=spot&assetId=BTC&limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=1");
    await expect(response.json()).resolves.toMatchObject({
      readOnly: true,
      venue: "gate",
      total: 2,
      truncated: true,
      instruments: [{ assetId: "BTC", venueSymbol: "BTC_USDT" }]
    });
  });

  it("keeps venue selection allowlisted and maps typed upstream failures", async () => {
    const adapter = fixtureAdapter();
    await expect((await request(adapter, "/unknown/tickers?marketType=spot")).json()).resolves.toMatchObject({
      availableVenues: ["gate"]
    });
    adapter.depth = vi.fn(async () => {
      throw new PublicVenueAdapterError("gate", "rate-limit", "request quota exceeded", 429);
    });
    const response = await request(adapter, "/gate/depth?marketType=spot&instrumentId=gate:spot:BTC_USDT");
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ readOnly: true, kind: "rate-limit" });
  });

  it("accepts stable registry IDs while passing the exact native symbol to adapters", async () => {
    const adapter = fixtureAdapter();
    adapter.depth = vi.fn(async (input) => ({
      venue: "gate", instrumentId: input.instrumentId, marketType: "spot", quantityUnit: "base",
      bids: [[99, 1]], asks: [[100, 1]], sequence: 1, exchangeTs: 1, receivedAt: 2, complete: true
    }));
    const response = await request(adapter, "/gate/depth?marketType=spot&instrumentId=gate:spot:BTC_USDT");
    expect(response.status).toBe(200);
    expect(adapter.depth).toHaveBeenCalledWith({ instrumentId: "BTC_USDT", marketType: "spot", limit: 50 }, expect.any(AbortSignal));
    await expect(response.json()).resolves.toMatchObject({ readOnly: true, instrumentId: "BTC_USDT" });
  });

  it("rejects unsupported query shapes before touching an adapter", async () => {
    const adapter = fixtureAdapter();
    const response = await request(adapter, "/gate/depth?marketType=wallet&instrumentId=../../secret&limit=9999");
    expect(response.status).toBe(400);
    expect(adapter.depth).not.toHaveBeenCalled();
  });

  it("aborts the upstream adapter when the HTTP client disconnects", async () => {
    const adapter = fixtureAdapter();
    let resolveAdapterAbort!: () => void;
    const adapterAborted = new Promise<void>((resolve) => {
      resolveAdapterAbort = resolve;
    });
    adapter.depth = vi.fn((_input, signal) => new Promise((_resolve, reject) => {
      const cancelled = () => {
        resolveAdapterAbort();
        reject(new PublicVenueAdapterError("gate", "cancelled", "request was cancelled"));
      };
      if (signal?.aborted) cancelled();
      else signal?.addEventListener("abort", cancelled, { once: true });
    }));
    const controller = new AbortController();
    const pending = request(adapter, "/gate/depth?marketType=spot&instrumentId=gate:spot:BTC_USDT", controller.signal);

    await vi.waitFor(() => expect(adapter.depth).toHaveBeenCalledOnce());
    controller.abort();
    await pending.catch(() => undefined);

    await expect(adapterAborted).resolves.toBeUndefined();
    expect(adapter.depth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aborted: true }));
  });

  it("coalesces identical public requests while retaining one subscription per client", async () => {
    const adapter = fixtureAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.depth = vi.fn(async (input) => {
      await gate;
      return depthFixture(input.instrumentId);
    });
    const path = "/gate/depth?marketType=spot&instrumentId=gate:spot:BTC_USDT";

    // Each helper call creates a distinct Express router. Coalescing therefore
    // proves that the default pool is process-wide rather than router-local.
    const first = request(adapter, path);
    const second = request(adapter, path);
    await vi.waitFor(() => expect(adapter.depth).toHaveBeenCalledOnce());

    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(adapter.depth).toHaveBeenCalledTimes(1);
  });

  it("returns retryable 503 overload instead of queueing distinct public work", async () => {
    const adapter = fixtureAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.depth = vi.fn(async (input) => {
      await gate;
      return depthFixture(input.instrumentId);
    });
    const sharedWork = new SharedAbortableWork<string, unknown>(1);
    const first = request(adapter, "/gate/depth?marketType=spot&instrumentId=gate:spot:BTC_USDT", undefined, sharedWork);
    await vi.waitFor(() => expect(adapter.depth).toHaveBeenCalledOnce());

    const overloaded = await request(adapter, "/gate/depth?marketType=spot&instrumentId=gate:spot:ETH_USDT", undefined, sharedWork);

    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    await expect(overloaded.json()).resolves.toMatchObject({ readOnly: true, kind: "overload" });
    expect(adapter.depth).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
  });

  it("requires and preserves perpetual scope for funding", async () => {
    const adapter = fixtureAdapter();
    adapter.funding = vi.fn(async (instrumentId) => ({
      venue: "gate",
      instrumentId,
      currentEstimateRate: 0.0001,
      fundingTime: 10_000,
      nextFundingTime: 20_000,
      intervalMinutes: 1,
      scheduleVerified: true,
      exchangeTs: 9_999,
      receivedAt: 10_000,
      history: [],
      sourceErrors: []
    }));

    const response = await request(adapter, "/gate/funding?marketType=perpetual&instrumentId=gate:perpetual:BTC_USDT&historyLimit=25");

    expect(response.status).toBe(200);
    expect(adapter.funding).toHaveBeenCalledWith("BTC_USDT", { historyLimit: 25, signal: expect.any(AbortSignal) });
    await expect(response.json()).resolves.toMatchObject({ readOnly: true, marketType: "perpetual", instrumentId: "BTC_USDT" });
  });

  it.each(["spot", "margin", "future", "option", "native-spread"])("rejects a %s stable ID on the funding route", async (scope) => {
    const adapter = fixtureAdapter();
    const response = await request(adapter, `/gate/funding?marketType=perpetual&instrumentId=gate:${scope}:BTC_USDT`);

    expect(response.status).toBe(400);
    expect(adapter.funding).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous stable ID with more than one embedded market scope", async () => {
    const adapter = fixtureAdapter();
    const response = await request(adapter, "/gate/funding?marketType=perpetual&instrumentId=gate:perpetual:forged:perpetual:BTC_USDT");

    expect(response.status).toBe(400);
    expect(adapter.funding).not.toHaveBeenCalled();
  });

  it("rejects funding requests without an explicit market scope", async () => {
    const adapter = fixtureAdapter();
    const response = await request(adapter, "/gate/funding?instrumentId=gate:perpetual:BTC_USDT");

    expect(response.status).toBe(400);
    expect(adapter.funding).not.toHaveBeenCalled();
  });
});

async function request(adapter: PublicVenueAdapter, path: string, signal?: AbortSignal, sharedWork?: SharedAbortableWork<string, unknown>) {
  const app = express();
  app.use("/api/market-data", createPublicVenueRouter(new Map([[adapter.venue, adapter]]), { sharedWork }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/market-data${path}`, { signal });
}

function depthFixture(instrumentId: string) {
  return {
    venue: "gate",
    instrumentId,
    marketType: "spot" as const,
    quantityUnit: "base" as const,
    bids: [[99, 1]] as const,
    asks: [[100, 1]] as const,
    sequence: 1,
    exchangeTs: 1,
    receivedAt: 2,
    complete: true as const
  };
}

function fixtureAdapter(): PublicVenueAdapter {
  const instrument = (venueSymbol: string) => ({
    id: `gate:spot:${venueSymbol}`,
    assetId: "BTC",
    venue: "gate",
    venueSymbol,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType: "spot" as const,
    contractMultiplier: 1,
    tickSize: 0.1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 1,
    status: "trading" as const
  });
  return {
    venue: "gate",
    capabilities: () => ({ venue: "gate", publicData: true, spot: true, margin: false, perpetual: true, datedFuture: false, option: false, nativeSpread: false, topBook: true, depth: true, publicTrades: false, funding: true, borrow: false, depositWithdrawal: false, privateExecution: false, demoEnvironment: true }),
    instruments: vi.fn(async () => ({ venue: "gate", marketType: "spot", receivedAt: 1, instruments: [instrument("BTC_USDT"), instrument("BTC_USDC")], rejectedRows: [] })),
    tickers: vi.fn(async () => ({ venue: "gate", marketType: "spot", receivedAt: 1, tickers: [], rejectedRows: [] })),
    ticker: vi.fn(),
    depth: vi.fn(),
    funding: vi.fn()
  };
}
