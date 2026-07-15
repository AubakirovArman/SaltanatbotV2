import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { TriangularScannerService } from "../src/arbitrage/engines/triangular/index.js";
import { ArbitrageOverloadError } from "../src/arbitrage/sharedAbortableWork.js";

describe("public triangular scanner service", () => {
  it("discovers a fee-adjusted non-executable candidate from a venue-wide REST top book", async () => {
    const instruments = [instrument("BTCUSDT", "BTC", "USDT", 0.0001, 10), instrument("ETHBTC", "ETH", "BTC", 0.001, 0.0005), instrument("ETHUSDT", "ETH", "USDT", 0.001, 10)];
    const service = new TriangularScannerService({
      now: () => 10_000,
      registry: { snapshot: async () => ({ updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] }) },
      fetch: async () =>
        json([
          { symbol: "BTCUSDT", bidPrice: "100", bidQty: "100", askPrice: "101", askQty: "100" },
          { symbol: "ETHBTC", bidPrice: "0.051", bidQty: "1000", askPrice: "0.052", askQty: "1000" },
          { symbol: "ETHUSDT", bidPrice: "5.4", bidQty: "1000", askPrice: "5.5", askQty: "1000" }
        ])
    });

    const scan = await service.scan({
      venue: "binance",
      startAsset: "USDT",
      startQuantity: 1_000,
      takerFeeBps: 5,
      minimumNetReturnBps: 0,
      limit: 20
    });

    expect(scan.marketDataMode).toBe("rest-top-book");
    expect(scan).toMatchObject({ snapshotSource: "rest-snapshot", executionStatus: "non-executable-candidate", sequenceVerified: false });
    expect(scan.scannedCycles).toBe(2);
    expect(scan.totalOpportunities).toBeGreaterThan(0);
    expect(scan.opportunities[0]?.netReturnBps).toBeGreaterThan(0);
    expect(scan.opportunities[0]?.legs).toHaveLength(3);
    expect(scan.opportunities[0]?.riskFlags).toEqual(expect.arrayContaining(["sequential-leg-risk", "top-book-only", "rest-snapshot"]));
    expect(scan.opportunities[0]).toMatchObject({ edgeKind: "non-executable-candidate", executionStatus: "non-executable-candidate", marketDataMode: "rest-top-book", sequenceVerified: false });
  });

  it("fails closed when venue metadata cannot form a verified cycle", async () => {
    const service = new TriangularScannerService({
      now: () => 10_000,
      registry: {
        snapshot: async () => {
          const instruments = [instrument("BTCUSDT", "BTC", "USDT", 0.0001, 10)];
          return { updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] };
        }
      },
      fetch: async () => json([{ symbol: "BTCUSDT", bidPrice: "100", bidQty: "100", askPrice: "101", askQty: "100" }])
    });
    const scan = await service.scan({ venue: "binance", startAsset: "USDT", startQuantity: 1_000, takerFeeBps: 5, minimumNetReturnBps: 0, limit: 20 });
    expect(scan.scannedCycles).toBe(0);
    expect(scan.opportunities).toEqual([]);
  });

  it("timestamps books after the complete payload is received", async () => {
    let now = 1_000;
    const instruments = profitableInstruments();
    const service = new TriangularScannerService({
      now: () => now,
      registry: { snapshot: async () => ({ updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] }) },
      fetch: (async () =>
        delayedJson(profitableRows(), () => {
          now = 5_000;
        })) as typeof fetch
    });

    const scan = await service.scan(scanOptions());

    expect(scan.updatedAt).toBe(5_000);
    expect(scan.opportunities[0]?.timestamps).toMatchObject({
      evaluatedAt: 5_000,
      oldestReceivedAt: 5_000,
      quoteAgeMs: 0,
      exchangeTimestampsVerified: false
    });
    expect(scan.opportunities[0]?.timestamps).not.toHaveProperty("oldestExchangeTs");
  });

  it("does not reset cached book age when the registry resolves slowly", async () => {
    let now = 1_000;
    let snapshotCalls = 0;
    const instruments = profitableInstruments();
    const fetcher = vi.fn(async () => json(profitableRows()));
    const service = new TriangularScannerService({
      now: () => now,
      cacheTtlMs: 3_000,
      registry: {
        snapshot: async () => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await Promise.resolve();
            now = 20_000;
          }
          return { updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] };
        }
      },
      fetch: fetcher
    });

    expect((await service.scan(scanOptions())).totalOpportunities).toBeGreaterThan(0);
    now = 2_000;
    const delayedScan = await service.scan(scanOptions());

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(delayedScan.updatedAt).toBe(20_000);
    expect(delayedScan.totalOpportunities).toBe(0);
  });

  it("coalesces a 100-request burst across registry, topology, simulation and venue-wide books", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const instruments = profitableInstruments();
    const registrySnapshot = vi.fn(async () => ({ updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] }));
    const fetcher = vi.fn(async () => {
      await gate;
      return json(profitableRows());
    });
    const service = new TriangularScannerService({
      now: () => 10_000,
      registry: { snapshot: registrySnapshot },
      fetch: fetcher
    });

    const pending = Array.from({ length: 100 }, () => service.scan({ ...scanOptions() }));
    await settleEventLoop();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registrySnapshot).toHaveBeenCalledTimes(1);

    release();
    const scans = await Promise.all(pending);
    expect(scans.every((scan) => scan === scans[0])).toBe(true);
    expect(scans[0]?.totalOpportunities).toBeGreaterThan(0);
  });

  it("rejects excess distinct full scans before registry or CPU work can grow without bounds", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const instruments = profitableInstruments();
    const registrySnapshot = vi.fn(async () => {
      await gate;
      return { updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] };
    });
    const service = new TriangularScannerService({
      now: () => 10_000,
      registry: { snapshot: registrySnapshot },
      fetch: async () => json(profitableRows())
    });

    const first = service.scan({ ...scanOptions(), takerFeeBps: 4 });
    const second = service.scan({ ...scanOptions(), takerFeeBps: 5 });
    await settleEventLoop();

    await expect(service.scan({ ...scanOptions(), takerFeeBps: 6 })).rejects.toBeInstanceOf(ArbitrageOverloadError);
    expect(registrySnapshot).toHaveBeenCalledTimes(2);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("observes disconnects at cooperative topology checkpoints", async () => {
    const instruments = Array.from({ length: 1_024 }, (_, index) => instrument(`A${index}USDT`, `A${index}`, "USDT", 0.001, 1));
    const rows = instruments.map((value) => ({ symbol: value.venueSymbol, bidPrice: "1", bidQty: "100", askPrice: "1.01", askQty: "100" }));
    const controller = new AbortController();
    const service = new TriangularScannerService({
      now: () => 10_000,
      registry: { snapshot: async () => ({ updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] }) },
      fetch: async () => {
        setImmediate(() => setImmediate(() => controller.abort(new Error("client disconnected during topology build"))));
        return json(rows);
      }
    });

    await expect(service.scan(scanOptions(), controller.signal)).rejects.toThrow("client disconnected during topology build");
  });

  it("propagates caller cancellation to the market-data request", async () => {
    let downstreamSignal: AbortSignal | undefined;
    const service = new TriangularScannerService({
      registry: {
        snapshot: async () => {
          const instruments = profitableInstruments();
          return { updatedAt: 1, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] };
        }
      },
      fetch: ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          downstreamSignal = init?.signal ?? undefined;
          downstreamSignal?.addEventListener("abort", () => reject(downstreamSignal?.reason ?? new Error("aborted")), { once: true });
        })) as typeof fetch
    });
    const controller = new AbortController();

    const pending = service.scan(scanOptions(), controller.signal);
    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow("client disconnected");
    expect(downstreamSignal?.aborted).toBe(true);
  });
});

function profitableInstruments() {
  return [instrument("BTCUSDT", "BTC", "USDT", 0.0001, 10), instrument("ETHBTC", "ETH", "BTC", 0.001, 0.0005), instrument("ETHUSDT", "ETH", "USDT", 0.001, 10)];
}

function profitableRows() {
  return [
    { symbol: "BTCUSDT", bidPrice: "100", bidQty: "100", askPrice: "101", askQty: "100" },
    { symbol: "ETHBTC", bidPrice: "0.051", bidQty: "1000", askPrice: "0.052", askQty: "1000" },
    { symbol: "ETHUSDT", bidPrice: "5.4", bidQty: "1000", askPrice: "5.5", askQty: "1000" }
  ];
}

function scanOptions() {
  return { venue: "binance" as const, startAsset: "USDT", startQuantity: 1_000, takerFeeBps: 5, minimumNetReturnBps: 0, limit: 20 };
}

function instrument(symbol: string, baseAsset: string, quoteAsset: string, quantityStep: number, minimumNotional: number): RegistryInstrument {
  return {
    id: `binance:spot:${symbol}`,
    assetId: baseAsset,
    venue: "binance",
    venueSymbol: symbol,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    tickSize: 0.000001,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional,
    status: "trading"
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function delayedJson(value: unknown, beforeRead: () => void): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return;
        sent = true;
        beforeRead();
        controller.enqueue(bytes);
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function settleEventLoop() {
  for (let step = 0; step < 3; step += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
