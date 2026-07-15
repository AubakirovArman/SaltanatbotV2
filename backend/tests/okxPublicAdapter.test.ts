import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OkxPublicAdapter } from "../src/venues/okx/adapter.js";

const SPOT_INSTRUMENTS = fixture("instruments-spot.json");
const SWAP_INSTRUMENTS = fixture("instruments-swap.json");
const FUTURES_INSTRUMENTS = fixture("instruments-futures.json");
const SWAP_TICKERS = fixture("tickers-swap.json");
const DEPTH = fixture("depth.json");
const FUNDING_CURRENT = fixture("funding-current.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("OKX public adapter conformance", () => {
  it("advertises only implemented read-only capabilities", () => {
    const capabilities = new OkxPublicAdapter({ fetch: routedFetch({}) }).capabilities();

    expect(capabilities).toMatchObject({
      venue: "okx",
      publicData: true,
      spot: true,
      perpetual: true,
      datedFuture: true,
      topBook: true,
      depth: true,
      funding: true,
      margin: false,
      option: false,
      privateExecution: false,
      borrow: false,
      depositWithdrawal: false
    });
  });

  it("normalizes spot, linear/inverse SWAP and dated-future metadata", async () => {
    const adapter = new OkxPublicAdapter({
      now: () => 9_000,
      fetch: routedFetch({
        "instruments:SPOT": SPOT_INSTRUMENTS,
        "instruments:SWAP": SWAP_INSTRUMENTS,
        "instruments:FUTURES": FUTURES_INSTRUMENTS
      })
    });

    const [spot, swaps, futures] = await Promise.all([adapter.instruments("spot"), adapter.instruments("perpetual"), adapter.instruments("future")]);

    expect(spot).toMatchObject({ venue: "okx", marketType: "spot", receivedAt: 9_000, rejectedRows: [] });
    expect(spot.instruments[0]).toMatchObject({
      id: "okx:spot:BTC-USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      quantityUnit: "base",
      tickSize: 0.1,
      quantityStep: 0.00000001,
      minimumQuantity: 0.00001
    });
    expect(swaps.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "okx:perpetual:BTC-USDT-SWAP",
          contractDirection: "linear",
          contractValue: 0.01,
          contractValueCurrency: "BTC",
          contractMultiplier: 0.01,
          quantityUnit: "contract",
          underlying: "BTC-USDT"
        }),
        expect.objectContaining({
          id: "okx:perpetual:BTC-USD-SWAP",
          contractDirection: "inverse",
          settleAsset: "BTC",
          contractValue: 100,
          contractValueCurrency: "USD"
        })
      ])
    );
    expect(futures.instruments[0]).toMatchObject({
      id: "okx:future:BTC-USDT-260925",
      marketType: "future",
      expiryTime: 1_790_294_400_000,
      instrumentFamily: "BTC-USDT"
    });
  });

  it("normalizes top-book ticker lists, one ticker and a complete depth snapshot", async () => {
    const adapter = new OkxPublicAdapter({
      now: () => 9_001,
      fetch: routedFetch({
        "tickers:SWAP": SWAP_TICKERS,
        "ticker:BTC-USDT-SWAP": SWAP_TICKERS,
        "books:BTC-USDT-SWAP": DEPTH
      })
    });

    const [tickers, ticker, depth] = await Promise.all([adapter.tickers("perpetual"), adapter.ticker("btc-usdt-swap", "perpetual"), adapter.depth({ instrumentId: "BTC-USDT-SWAP", marketType: "perpetual", limit: 25 })]);

    expect(tickers.rejectedRows).toEqual([]);
    expect(tickers.tickers[0]).toMatchObject({
      instrumentId: "BTC-USDT-SWAP",
      quantityUnit: "contract",
      bid: 62100.1,
      bidSize: 11,
      ask: 62100.2,
      askSize: 14,
      volume24h: 102400,
      exchangeTs: 1_784_000_000_123,
      receivedAt: 9_001
    });
    expect(ticker).toEqual(tickers.tickers[0]);
    expect(depth).toMatchObject({
      venue: "okx",
      instrumentId: "BTC-USDT-SWAP",
      marketType: "perpetual",
      quantityUnit: "contract",
      sequence: 987654321,
      complete: true,
      exchangeTs: 1_784_000_000_123,
      receivedAt: 9_001
    });
    expect(depth.bids).toEqual([
      [62100.1, 11, 4],
      [62100, 8, 2]
    ]);
    expect(depth.asks).toEqual([
      [62100.2, 14, 3],
      [62100.3, 9, 2]
    ]);
  });

  it("derives a variable funding schedule and preserves settled history", async () => {
    const adapter = new OkxPublicAdapter({
      now: () => 9_002,
      fetch: routedFetch({ funding: FUNDING_CURRENT, "funding-history": FUNDING_HISTORY })
    });

    const funding = await adapter.funding("BTC-USDT-SWAP", { historyLimit: 250 });

    expect(funding).toMatchObject({
      venue: "okx",
      instrumentId: "BTC-USDT-SWAP",
      currentEstimateRate: 0.00012,
      nextEstimateRate: 0.00008,
      settledRate: 0.00011,
      fundingTime: 1_784_001_600_000,
      nextFundingTime: 1_784_016_000_000,
      intervalMinutes: 240,
      scheduleVerified: true,
      formulaType: "withRate",
      method: "current_period",
      sourceErrors: [],
      receivedAt: 9_002
    });
    expect(funding.history).toHaveLength(2);
    expect(funding.history[0]).toMatchObject({ fundingRate: 0.0001, realizedRate: 0.00009 });
  });

  it("keeps current funding usable when only history fails", async () => {
    const adapter = new OkxPublicAdapter({
      fetch: routedFetch({ funding: FUNDING_CURRENT, "funding-history": { status: 503, body: {} } })
    });

    const funding = await adapter.funding("BTC-USDT-SWAP");

    expect(funding.currentEstimateRate).toBe(0.00012);
    expect(funding.history).toEqual([]);
    expect(funding.sourceErrors[0]).toContain("HTTP 503");
  });

  it("rejects crossed, unsorted or wholly malformed market data", async () => {
    const crossedTicker = {
      code: "0",
      msg: "",
      data: [{ instType: "SWAP", instId: "BTC-USDT-SWAP", bidPx: "10", bidSz: "1", askPx: "9", askSz: "1", ts: "1" }]
    };
    const unsortedDepth = {
      code: "0",
      msg: "",
      data: [
        {
          bids: [
            ["9", "1"],
            ["10", "1"]
          ],
          asks: [["11", "1"]],
          ts: "1",
          seqId: "1"
        }
      ]
    };
    const adapter = new OkxPublicAdapter({
      fetch: routedFetch({ "tickers:SWAP": crossedTicker, "books:BTC-USDT-SWAP": unsortedDepth })
    });

    await expect(adapter.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC-USDT-SWAP", marketType: "perpetual" })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC-USDT-SWAP", marketType: "perpetual", limit: 401 })).rejects.toMatchObject({
      kind: "validation"
    });
  });

  it("classifies exchange errors, rate limits, timeouts and caller cancellation", async () => {
    const exchangeAdapter = new OkxPublicAdapter({ fetch: routedFetch({ "tickers:SWAP": EXCHANGE_ERROR }) });
    const limitedAdapter = new OkxPublicAdapter({ fetch: routedFetch({ "tickers:SWAP": { status: 429, body: {} } }) });

    await expect(exchangeAdapter.tickers("perpetual")).rejects.toMatchObject({ kind: "exchange" });
    await expect(limitedAdapter.tickers("perpetual")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });

    const timeoutAdapter = new OkxPublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeoutAdapter.tickers("perpetual")).rejects.toMatchObject({ kind: "timeout" });

    const cancellationAdapter = new OkxPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellationAdapter.tickers("perpetual", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });

    const fundingCancellationAdapter = new OkxPublicAdapter({
      fetch: ((input, init) => {
        if (String(input).includes("funding-rate-history")) return abortingFetch()(input, init);
        return Promise.resolve(jsonResponse(FUNDING_CURRENT));
      }) as typeof fetch,
      timeoutMs: 1_000
    });
    const fundingController = new AbortController();
    const fundingRequest = fundingCancellationAdapter.funding("BTC-USDT-SWAP", { signal: fundingController.signal });
    fundingController.abort();
    await expect(fundingRequest).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("cancels an oversized chunked upstream response at the adapter boundary", async () => {
    const cancelled = vi.fn();
    const adapter = new OkxPublicAdapter({
      maxPayloadBytes: 16,
      fetch: (async () => chunkedOversizedResponse(cancelled)) as typeof fetch
    });

    await expect(adapter.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/okx/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected OKX fixture URL: ${url}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL) {
  if (url.pathname.endsWith("/public/instruments")) return `instruments:${url.searchParams.get("instType")}`;
  if (url.pathname.endsWith("/market/tickers")) return `tickers:${url.searchParams.get("instType")}`;
  if (url.pathname.endsWith("/market/ticker")) return `ticker:${url.searchParams.get("instId")}`;
  if (url.pathname.endsWith("/market/books")) return `books:${url.searchParams.get("instId")}`;
  if (url.pathname.endsWith("/public/funding-rate-history")) return "funding-history";
  if (url.pathname.endsWith("/public/funding-rate")) return "funding";
  return url.pathname;
}

function isResponseConfig(value: unknown): value is { status: number; body: unknown } {
  return Boolean(value && typeof value === "object" && "status" in value && "body" in value);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function abortingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function chunkedOversizedResponse(cancelled: () => void) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"code":"0","'));
      controller.enqueue(encoder.encode('data":[{"more":"bytes"}]}'));
    },
    cancel: cancelled
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
