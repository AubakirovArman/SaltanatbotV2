import { describe, expect, it, vi } from "vitest";
import { BybitSpreadAdapter, BybitSpreadError, NativeSpreadScannerService } from "../src/arbitrage/nativeSpreads/index.js";
import type { NativeSpreadBook, NativeSpreadInstrument } from "../src/arbitrage/nativeSpreads/types.js";

describe("Bybit venue-native spread adapter", () => {
  it("paginates instruments, validates metadata and reports rejected rows", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return response(envelope({ list: [instrumentRow("SOLUSDT_SOL/USDT"), { ...instrumentRow("BAD"), tickSize: "0" }], nextPageCursor: "page-2" }, 1_000));
      expect(cursor).toBe("page-2");
      return response(envelope({ list: [instrumentRow("BTCUSDT_BTC/USDT", "CarryTrade")], nextPageCursor: "" }, 1_010));
    });
    const adapter = new BybitSpreadAdapter({ fetch: fetcher as typeof fetch, now: () => 2_000, baseUrl: "https://unit.test" });

    const result = await adapter.instruments();

    expect(result.instruments.map((row) => row.symbol)).toEqual(["SOLUSDT_SOL/USDT", "BTCUSDT_BTC/USDT"]);
    expect(result.instruments[0]).toMatchObject({ contractType: "FundingRateArb", quantityStep: 0.1, minimumQuantity: 0.1 });
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.exchangeTs).toBe(1_010);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts negative spread prices but rejects crossed books", async () => {
    const valid = new BybitSpreadAdapter({
      fetch: (async () => response(envelope({ s: "SOLUSDT_SOL/USDT", b: [["-1.25", "2"]], a: [["-1.20", "3"]], u: 9, seq: 10, ts: 5_000, cts: 4_999 }, 5_001))) as typeof fetch,
      now: () => 5_010,
      baseUrl: "https://unit.test"
    });
    await expect(valid.orderBook("SOLUSDT_SOL/USDT")).resolves.toMatchObject({ bidPrice: -1.25, askPrice: -1.2, bidQuantity: 2, askQuantity: 3 });

    const crossed = new BybitSpreadAdapter({
      fetch: (async () => response(envelope({ s: "SOLUSDT_SOL/USDT", b: [["1.25", "2"]], a: [["1.20", "3"]], u: 9, seq: 10, ts: 5_000, cts: 4_999 }, 5_001))) as typeof fetch,
      now: () => 5_010,
      baseUrl: "https://unit.test"
    });
    await expect(crossed.orderBook("SOLUSDT_SOL/USDT")).rejects.toMatchObject({ kind: "validation" });
  });

  it("bounds payload size and preserves an explicit exchange error", async () => {
    const oversized = new BybitSpreadAdapter({
      fetch: (async () => new Response("x".repeat(101), { status: 200 })) as typeof fetch,
      maxPayloadBytes: 100,
      baseUrl: "https://unit.test"
    });
    await expect(oversized.instruments()).rejects.toMatchObject({ kind: "validation" });

    const exchange = new BybitSpreadAdapter({
      fetch: (async () => response({ retCode: 10001, retMsg: "bad request", result: {}, time: 1 })) as typeof fetch,
      baseUrl: "https://unit.test"
    });
    await expect(exchange.instruments()).rejects.toEqual(expect.objectContaining<Partial<BybitSpreadError>>({ kind: "exchange" }));
  });
});

describe("venue-native spread scanner", () => {
  it("coalesces identical scans across callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const instrumentsCall = vi.fn(async () => {
      await gate;
      return { instruments: [instrument("A_PERP_A/SPOT", "FundingRateArb")], rejectedRows: [], exchangeTs: 9_990 };
    });
    const orderBook = vi.fn(async (symbol: string) => book(symbol, 1, 2, 5, 5, 9_990));
    const service = new NativeSpreadScannerService({
      now: () => 10_000,
      adapter: { instruments: instrumentsCall, orderBook }
    });
    const options = { minimumQuantity: 0, sort: "capacity" as const, maxCandidates: 1, limit: 1 };

    const first = service.scan(options);
    const second = service.scan({ ...options });
    await settleEventLoop();
    expect(instrumentsCall).toHaveBeenCalledTimes(1);

    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(orderBook).toHaveBeenCalledTimes(1);
  });

  it("rejects excess distinct scans instead of creating an upstream queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new NativeSpreadScannerService({
      now: () => 10_000,
      maxConcurrentScans: 1,
      adapter: {
        instruments: async () => {
          await gate;
          return { instruments: [], rejectedRows: [], exchangeTs: 9_990 };
        },
        orderBook: async (symbol) => book(symbol, 1, 2, 5, 5, 9_990)
      }
    });
    const first = service.scan({ baseCoin: "A", minimumQuantity: 0, sort: "capacity", maxCandidates: 1, limit: 1 });
    await settleEventLoop();

    await expect(service.scan({ baseCoin: "B", minimumQuantity: 0, sort: "capacity", maxCandidates: 1, limit: 1 })).rejects.toMatchObject({
      code: "ARBITRAGE_OVERLOADED"
    });

    release();
    await expect(first).resolves.toMatchObject({ opportunities: [] });
  });

  it("propagates scan cancellation instead of publishing a successful empty scan", async () => {
    let resolveAdapterAbort!: () => void;
    const adapterAborted = new Promise<void>((resolve) => {
      resolveAdapterAbort = resolve;
    });
    const service = new NativeSpreadScannerService({
      now: () => 10_000,
      adapter: {
        instruments: async () => ({ instruments: [instrument("A_PERP_A/SPOT", "FundingRateArb")], rejectedRows: [], exchangeTs: 9_990 }),
        orderBook: (_symbol, _limit, signal) => new Promise((_resolve, reject) => {
          const abort = () => {
            resolveAdapterAbort();
            reject(signal?.reason ?? new Error("cancelled"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        })
      }
    });
    const controller = new AbortController();
    const scan = service.scan({ minimumQuantity: 0, sort: "capacity", maxCandidates: 1, limit: 1 }, controller.signal);
    await settleEventLoop();

    controller.abort(new Error("subscriber cancelled"));

    await expect(scan).rejects.toThrow("subscriber cancelled");
    await expect(adapterAborted).resolves.toBeUndefined();
  });

  it("filters, ranks and labels only fresh two-sided native books", async () => {
    const instruments = [instrument("A_PERP_A/SPOT", "FundingRateArb"), instrument("B_FUT_B/SPOT", "CarryTrade"), instrument("C_FUT_C/SPOT", "CarryTrade")];
    const books: Record<string, NativeSpreadBook> = {
      "A_PERP_A/SPOT": book("A_PERP_A/SPOT", 1, 2, 8, 4, 99_900),
      "B_FUT_B/SPOT": book("B_FUT_B/SPOT", -3, -2, 10, 12, 99_950),
      "C_FUT_C/SPOT": book("C_FUT_C/SPOT", 2, 3, 100, 100, 80_000)
    };
    const service = new NativeSpreadScannerService({
      now: () => 100_000,
      concurrency: 2,
      adapter: {
        instruments: async () => ({ instruments, rejectedRows: [], exchangeTs: 99_900 }),
        orderBook: async (symbol) => books[symbol]!
      }
    });

    const scan = await service.scan({ contractType: "CarryTrade", minimumQuantity: 0, sort: "capacity", maxCandidates: 10, limit: 10 });

    expect(scan.executionModel).toBe("venue-matched-multi-leg");
    expect(scan.readOnly).toBe(true);
    expect(scan.eligibleInstruments).toBe(2);
    expect(scan.healthyBooks).toBe(1);
    expect(scan.opportunities[0]).toMatchObject({ symbol: "B_FUT_B/SPOT", bookWidth: 1, executableQuantity: 10 });
    expect(scan.sourceErrors[0]).toContain("stale");
    expect(scan.opportunities[0]?.riskFlags).toContain("revalidate-before-order");
  });

  it.each([
    {
      sort: "capacity" as const,
      first: { maximumQuantity: 5 },
      best: { maximumQuantity: 500 }
    },
    {
      sort: "tightness" as const,
      first: { tickSize: 0.1 },
      best: { tickSize: 0.001 }
    },
    {
      sort: "freshness" as const,
      first: { launchTime: 1 },
      best: { launchTime: 2_000 }
    }
  ])("uses $sort metadata when preselecting a truncated candidate universe", async ({ sort, first, best }) => {
    const instruments = [instrument("A_PERP_A/SPOT", "FundingRateArb", first), instrument("Z_PERP_Z/SPOT", "FundingRateArb", best)];
    const orderBook = vi.fn(async (symbol: string) => book(symbol, 1, 2, 5, 5, 9_990));
    const service = new NativeSpreadScannerService({
      now: () => 10_000,
      adapter: {
        instruments: async () => ({ instruments, rejectedRows: [], exchangeTs: 9_990 }),
        orderBook
      }
    });
    const scan = await service.scan({ minimumQuantity: 0, sort, maxCandidates: 1, limit: 1 });

    expect(orderBook).toHaveBeenCalledWith("Z_PERP_Z/SPOT", 1, expect.any(AbortSignal));
    expect(scan.opportunities[0]?.symbol).toBe("Z_PERP_Z/SPOT");
    expect(scan.candidateTruncated).toBe(true);
    expect(scan.truncated).toBe(true);
    expect(scan.scannedInstruments).toBe(1);
  });

  it("floors executable quantity to the venue quantity step", async () => {
    const instruments = [instrument("A_PERP_A/SPOT", "FundingRateArb", { quantityStep: 0.1, minimumQuantity: 0.1 })];
    const service = new NativeSpreadScannerService({
      now: () => 10_000,
      adapter: {
        instruments: async () => ({ instruments, rejectedRows: [], exchangeTs: 9_990 }),
        orderBook: async (symbol) => book(symbol, 1, 2, 1.09, 2.05, 9_990)
      }
    });

    const scan = await service.scan({ minimumQuantity: 0, sort: "capacity", maxCandidates: 1, limit: 1 });

    expect(scan.opportunities[0]?.executableQuantity).toBe(1);
  });

  it("re-ages every book when the whole pooled scan completes", async () => {
    let now = 10_000;
    let resolveDelayed!: (value: NativeSpreadBook) => void;
    const delayedBook = new Promise<NativeSpreadBook>((resolve) => {
      resolveDelayed = resolve;
    });
    const instruments = [instrument("A_PERP_A/SPOT", "FundingRateArb"), instrument("B_PERP_B/SPOT", "FundingRateArb")];
    const service = new NativeSpreadScannerService({
      now: () => now,
      concurrency: 2,
      adapter: {
        instruments: async () => ({ instruments, rejectedRows: [], exchangeTs: 9_999 }),
        orderBook: async (symbol) => (symbol.startsWith("A_") ? book(symbol, 1, 2, 5, 5, 1) : delayedBook)
      }
    });

    const scanPromise = service.scan({ minimumQuantity: 0, sort: "capacity", maxCandidates: 2, limit: 2 });
    await settleEventLoop();
    now = 12_000;
    resolveDelayed(book("B_PERP_B/SPOT", 1, 2, 5, 5, 11_990));
    const scan = await scanPromise;

    expect(scan.updatedAt).toBe(12_000);
    expect(scan.healthyBooks).toBe(1);
    expect(scan.opportunities).toHaveLength(1);
    expect(scan.opportunities[0]).toMatchObject({ symbol: "B_PERP_B/SPOT", quoteAgeMs: 10 });
    expect(scan.sourceErrors).toContain("A_PERP_A/SPOT: stale by 11999ms at scan completion");
  });
});

function instrumentRow(symbol: string, contractType = "FundingRateArb") {
  return {
    symbol,
    contractType,
    status: "Trading",
    baseCoin: symbol.startsWith("BTC") ? "BTC" : "SOL",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: "0.0001",
    minPrice: "-2000",
    maxPrice: "2000",
    lotSize: "0.1",
    minSize: "0.1",
    maxSize: "50000",
    launchTime: "1000",
    deliveryTime: "0",
    legs: [
      { symbol: symbol.split("_")[0], contractType: contractType === "CarryTrade" ? "LinearFutures" : "LinearPerpetual" },
      { symbol: symbol.split("_")[0], contractType: "Spot" }
    ]
  };
}

function instrument(symbol: string, contractType: NativeSpreadInstrument["contractType"], overrides: Partial<NativeSpreadInstrument> = {}): NativeSpreadInstrument {
  return {
    symbol,
    contractType,
    status: "Trading",
    baseCoin: symbol[0]!,
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: 0.01,
    minimumPrice: -100,
    maximumPrice: 100,
    quantityStep: 1,
    minimumQuantity: 1,
    maximumQuantity: 1_000,
    launchTime: 1,
    legs: [
      { symbol: `${symbol[0]}USDT`, contractType: contractType === "FundingRateArb" ? "LinearPerpetual" : "LinearFutures" },
      { symbol: `${symbol[0]}USDT`, contractType: "Spot" }
    ],
    ...overrides
  };
}

function book(symbol: string, bidPrice: number, askPrice: number, bidQuantity: number, askQuantity: number, exchangeTs: number): NativeSpreadBook {
  return { symbol, bidPrice, askPrice, bidQuantity, askQuantity, sequence: 1, exchangeTs, matchingEngineTs: exchangeTs, receivedAt: exchangeTs + 1 };
}

function envelope(result: unknown, time: number) {
  return { retCode: 0, retMsg: "OK", result, time };
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function settleEventLoop() {
  for (let step = 0; step < 3; step += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
