import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAbortableWork } from "../src/arbitrage/sharedAbortableWork.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/index.js";
import { createPublicVenueRouter } from "../src/venues/publicRoutes.js";
import { PublicVenueAdapterError, type PublicVenueAdapter } from "../src/venues/publicTypes.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const source = "gate.public-rest";

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("public venue resource governor integration", () => {
  it("publishes credential-free upstream health", async () => {
    const resources = governor(() => 123);
    const response = await request(fixtureAdapter(), "/health/upstreams", resources);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      readOnly: true,
      generatedAt: 123,
      healthy: true,
      totals: { sources: 1, active: 0 },
      sources: [{ source, state: "closed", active: 0 }]
    });
  });

  it("fails closed before I/O when an adapter has no named process budget", async () => {
    const resources = governor(Date.now);
    const adapter = { ...fixtureAdapter(), venue: "unbudgeted", tickers: vi.fn() } satisfies PublicVenueAdapter;
    const response = await request(adapter, "/unbudgeted/tickers?marketType=spot", resources);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ readOnly: true, kind: "upstream", error: expect.stringContaining("No process-wide") });
    expect(adapter.tickers).not.toHaveBeenCalled();
  });

  it("rejects distinct route work at the venue budget instead of queueing", async () => {
    const resources = governor(Date.now, { maxConcurrent: 1 });
    const adapter = fixtureAdapter();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.depth = vi.fn(async (input) => {
      await blocked;
      return depth(input.instrumentId);
    });

    const first = request(adapter, "/gate/depth?marketType=spot&instrumentId=BTC_USDT", resources);
    await vi.waitFor(() => expect(adapter.depth).toHaveBeenCalledOnce());
    const overloaded = await request(adapter, "/gate/depth?marketType=spot&instrumentId=ETH_USDT", resources);

    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    await expect(overloaded.json()).resolves.toMatchObject({ readOnly: true, kind: "overload" });
    expect(resources.sourceSnapshot(source)).toMatchObject({ active: 1, counters: { overloadRejected: 1 } });
    release();
    expect((await first).status).toBe(200);
  });

  it("attributes a pre-lease shared-pool rejection to the named source", async () => {
    const resources = governor(Date.now, { maxConcurrent: 2 });
    const work = new SharedAbortableWork<string, unknown>(1);
    const adapter = fixtureAdapter();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.depth = vi.fn(async (input) => {
      await blocked;
      return depth(input.instrumentId);
    });

    const first = request(adapter, "/gate/depth?marketType=spot&instrumentId=BTC_USDT", resources, work);
    await vi.waitFor(() => expect(adapter.depth).toHaveBeenCalledOnce());
    const overloaded = await request(adapter, "/gate/depth?marketType=spot&instrumentId=ETH_USDT", resources, work);

    expect(overloaded.status).toBe(503);
    expect(resources.sourceSnapshot(source)).toMatchObject({ active: 1, counters: { overloadRejected: 1 } });
    release();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it("opens a route circuit only for upstream failures and recovers through a probe", async () => {
    let now = 10;
    const resources = governor(() => now, { failureThreshold: 1, cooldownMs: 50 });
    const adapter = fixtureAdapter();
    adapter.depth = vi.fn(async () => {
      throw new PublicVenueAdapterError("gate", "timeout", "request timed out");
    });

    const failed = await request(adapter, "/gate/depth?marketType=spot&instrumentId=BTC_USDT", resources);
    expect(failed.status).toBe(504);
    const blocked = await request(adapter, "/gate/depth?marketType=spot&instrumentId=ETH_USDT", resources);
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({ kind: "circuit-open" });
    expect(adapter.depth).toHaveBeenCalledTimes(1);

    now += 50;
    adapter.depth = vi.fn(async (input) => depth(input.instrumentId));
    const recovered = await request(adapter, "/gate/depth?marketType=spot&instrumentId=BTC_USDT", resources);
    expect(recovered.status).toBe(200);
    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });
});

function governor(now: () => number, overrides: Partial<{ maxConcurrent: number; failureThreshold: number; cooldownMs: number }> = {}) {
  return new UpstreamResourceGovernor(
    {
      [source]: {
        maxConcurrent: overrides.maxConcurrent ?? 2,
        failureThreshold: overrides.failureThreshold ?? 2,
        cooldownMs: overrides.cooldownMs ?? 100
      }
    },
    now
  );
}

async function request(adapter: PublicVenueAdapter, route: string, resources: UpstreamResourceGovernor, sharedWork?: SharedAbortableWork<string, unknown>) {
  const app = express();
  app.use("/api/market-data", createPublicVenueRouter(new Map([[adapter.venue, adapter]]), { governor: resources, sharedWork }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/market-data${route}`);
}

function fixtureAdapter(): PublicVenueAdapter {
  return {
    venue: "gate",
    capabilities: () => ({ venue: "gate", publicData: true, spot: true, margin: false, perpetual: true, datedFuture: false, option: false, nativeSpread: false, topBook: true, depth: true, publicTrades: false, funding: true, borrow: false, depositWithdrawal: false, privateExecution: false, demoEnvironment: true }),
    instruments: vi.fn(),
    tickers: vi.fn(),
    ticker: vi.fn(),
    depth: vi.fn(),
    funding: vi.fn()
  };
}

function depth(instrumentId: string) {
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
