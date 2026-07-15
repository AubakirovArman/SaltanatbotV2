import { describe, expect, it, vi } from "vitest";
import { ArbitrageScannerService } from "../src/arbitrage/service.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/index.js";

const scanOptions = { estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 10 };

describe("basis scanner REST resource governor", () => {
  it("rejects excess per-venue work without creating a queue", async () => {
    const resources = governor(() => 1, 2, 2);
    const pending: PendingFetch[] = [];
    const service = new ArbitrageScannerService({
      now: () => 1,
      cacheTtlMs: 0,
      governor: resources,
      fetch: async (input) => await new Promise<Response>((resolve) => pending.push({ url: String(input), resolve }))
    });

    const scan = service.scan(scanOptions);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(resources.sourceSnapshot("binance.public-rest")).toMatchObject({ active: 2, available: 0, counters: { overloadRejected: 1 } });
    expect(resources.sourceSnapshot("bybit.public-rest")).toMatchObject({ active: 2, available: 0, counters: { overloadRejected: 0 } });

    for (const request of pending) request.resolve(responseFor(request.url));
    await expect(scan).resolves.toMatchObject({ totalOpportunities: 0, opportunities: [] });
    expect(resources.snapshot()).toMatchObject({ totals: { active: 0, overloadRejected: 1 } });
  });

  it("shares an open source circuit across later scanner snapshots", async () => {
    let now = 100;
    const resources = governor(() => now, 3, 2, 1);
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const service = new ArbitrageScannerService({ now: () => now, cacheTtlMs: 0, governor: resources, fetch: fetcher });

    await expect(service.scan(scanOptions)).resolves.toMatchObject({ totalOpportunities: 0 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(resources.sourceSnapshot("binance.public-rest")).toMatchObject({ state: "open", counters: { failed: 3 } });
    expect(resources.sourceSnapshot("bybit.public-rest")).toMatchObject({ state: "open", counters: { failed: 2 } });

    now += 1;
    await expect(service.scan(scanOptions)).resolves.toMatchObject({ totalOpportunities: 0 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(resources.snapshot().totals.circuitRejected).toBe(5);
  });

  it("accounts final-subscriber cancellation as aborts without opening circuits", async () => {
    const resources = governor(Date.now, 3, 2, 1);
    let started = 0;
    const service = new ArbitrageScannerService({
      governor: resources,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          started += 1;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
    });
    const controller = new AbortController();
    const scan = service.scan(scanOptions, controller.signal);
    await vi.waitFor(() => expect(started).toBe(5));

    controller.abort(new DOMException("caller left", "AbortError"));
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(resources.snapshot().totals.active).toBe(0));

    expect(resources.sourceSnapshot("binance.public-rest")).toMatchObject({ state: "closed", counters: { aborted: 3, failed: 0 } });
    expect(resources.sourceSnapshot("bybit.public-rest")).toMatchObject({ state: "closed", counters: { aborted: 2, failed: 0 } });
  });
});

interface PendingFetch {
  url: string;
  resolve: (response: Response) => void;
}

function governor(now: () => number, binanceConcurrency: number, bybitConcurrency: number, failureThreshold = 4) {
  return new UpstreamResourceGovernor(
    {
      "binance.public-rest": { maxConcurrent: binanceConcurrency, failureThreshold, cooldownMs: 500 },
      "bybit.public-rest": { maxConcurrent: bybitConcurrency, failureThreshold, cooldownMs: 500 }
    },
    now
  );
}

function responseFor(url: string) {
  return new Response(JSON.stringify(url.includes("api.bybit.com") ? { retCode: 0, retMsg: "OK", time: 1, result: { list: [] } } : []), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
