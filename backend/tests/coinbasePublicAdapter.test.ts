import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { COINBASE_PUBLIC_CAPABILITIES, COINBASE_PUBLIC_VENUE_PLUGIN, CoinbasePublicAdapter, type CoinbasePublicAdapterOptions } from "../src/venues/coinbase/index.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";
import { validatePublicOperationResult } from "../src/venues/conformance/index.js";

const PRODUCTS = fixture("products.json");
const BOOK_L1 = fixture("book-l1.json");
const BOOK_L2 = fixture("book-l2.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("Coinbase Exchange public adapter", () => {
  it("advertises a public Spot-only capability and no private JWT authority", () => {
    const adapter = new CoinbasePublicAdapter({ fetch: routedFetch({}) });

    expectTypeOf(adapter).toMatchTypeOf<PublicVenueAdapter>();
    expectTypeOf<CoinbasePublicAdapterOptions>().toBeObject();
    expect(adapter.capabilities()).toEqual(COINBASE_PUBLIC_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      venue: "coinbase",
      publicData: true,
      spot: true,
      perpetual: false,
      datedFuture: false,
      funding: false,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false
    });
    expect(COINBASE_PUBLIC_VENUE_PLUGIN).toMatchObject({
      venue: "coinbase",
      authority: "public-read-only",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });
  });

  it("normalizes Spot products while keeping USD and USDC as separate identities", async () => {
    const adapter = new CoinbasePublicAdapter({ now: () => 9_100, fetch: routedFetch({ products: PRODUCTS }) });

    const snapshot = await adapter.instruments("spot");

    expect(snapshot).toMatchObject({ venue: "coinbase", marketType: "spot", receivedAt: 9_100, rejectedRows: [] });
    expect(snapshot.instruments).toEqual([
      expect.objectContaining({
        id: "coinbase:spot:BTC-USD",
        baseAsset: "BTC",
        quoteAsset: "USD",
        settleAsset: "USD",
        quantityUnit: "base",
        tickSize: 0.01,
        quantityStep: 0.00000001,
        minimumQuantity: 0,
        minimumNotional: 1
      }),
      expect.objectContaining({
        id: "coinbase:spot:BTC-USDC",
        quoteAsset: "USDC",
        settleAsset: "USDC"
      })
    ]);
    expect(snapshot.instruments[0]!.economicAssetId).toBeUndefined();
    expect(snapshot.instruments[1]!.economicAssetId).toBeUndefined();
    validatePublicOperationResult("instruments", snapshot, { venue: "coinbase", marketType: "spot", maxItems: 5_000 });
  });

  it("normalizes credential-free L1 and bounded aggregated L2 with exact sizes", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const adapter = new CoinbasePublicAdapter({
      now: () => 9_101,
      fetch: routedFetch({ "book:BTC-USD:1": BOOK_L1, "book:BTC-USD:2": BOOK_L2 }, requests)
    });

    const [ticker, depth] = await Promise.all([adapter.ticker("btc-usd", "spot"), adapter.depth({ instrumentId: "BTC-USD", marketType: "spot", limit: 2 })]);

    expect(ticker).toMatchObject({
      venue: "coinbase",
      instrumentId: "BTC-USD",
      quantityUnit: "base",
      bid: 64544.21,
      bidSize: 0.74743612,
      ask: 64544.22,
      askSize: 1.67198587,
      exchangeTs: Date.parse("2026-07-14T19:19:23.190Z"),
      receivedAt: 9_101
    });
    expect(depth).toMatchObject({
      instrumentId: "BTC-USD",
      quantityUnit: "base",
      sequence: 132647117442,
      complete: true,
      exchangeTs: Date.parse("2026-07-14T19:19:24.000Z")
    });
    expect(depth.bids).toEqual([
      [64544.21, 0.74743612, 11],
      [64544.2, 0.5, 2]
    ]);
    expect(depth.asks).toHaveLength(2);
    expect(requests.map((item) => item.url.searchParams.get("level")).sort()).toEqual(["1", "2"]);
    expect(requests.every((item) => !item.headers.has("authorization"))).toBe(true);
    validatePublicOperationResult("ticker", ticker, {
      venue: "coinbase",
      marketType: "spot",
      instrumentId: "BTC-USD",
      maxItems: 1
    });
    validatePublicOperationResult("depth", depth, {
      venue: "coinbase",
      marketType: "spot",
      instrumentId: "BTC-USD",
      maxItems: 500
    });
  });

  it("does not fake a bulk BBO, derivatives or funding surface", async () => {
    const adapter = new CoinbasePublicAdapter({ fetch: routedFetch({}) });

    await expect(adapter.tickers("spot")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.instruments("perpetual")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.ticker("BTC-USD", "future")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.funding("BTC-USD")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("fails closed on auctions, crossed/unsorted books and malformed product identity", async () => {
    const auction = { ...(BOOK_L1 as object), auction_mode: true };
    const crossed = { ...(BOOK_L1 as any), bids: [["11", "1", 1]], asks: [["10", "1", 1]] };
    const unsorted = {
      ...(BOOK_L2 as any),
      bids: [
        ["9", "1", 1],
        ["10", "1", 1]
      ]
    };
    const malformedProducts = [{ ...(PRODUCTS as any[])[0], id: "ETH-USD" }];
    const adapter = new CoinbasePublicAdapter({
      fetch: routedFetch({
        products: malformedProducts,
        "book:BTC-USD:1": auction,
        "book:ETH-USD:1": crossed,
        "book:BTC-USD:2": unsorted
      })
    });

    await expect(adapter.instruments("spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.ticker("BTC-USD", "spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.ticker("ETH-USD", "spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC-USD", marketType: "spot" })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC-USD", marketType: "spot", limit: 501 })).rejects.toMatchObject({ kind: "validation" });
  });

  it("classifies exchange/rate/HTTP/timeout/cancellation and validates the origin", async () => {
    const exchange = new CoinbasePublicAdapter({
      fetch: routedFetch({ "book:BTC-USD:1": responseConfig(400, EXCHANGE_ERROR) })
    });
    const limited = new CoinbasePublicAdapter({ fetch: routedFetch({ products: responseConfig(429, {}) }) });
    const failed = new CoinbasePublicAdapter({ fetch: routedFetch({ products: responseConfig(503, {}) }) });

    await expect(exchange.ticker("BTC-USD", "spot")).rejects.toMatchObject({ kind: "exchange", status: 400 });
    await expect(limited.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    await expect(failed.instruments("spot")).rejects.toMatchObject({ kind: "http", status: 503 });

    const timeout = new CoinbasePublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeout.instruments("spot")).rejects.toMatchObject({ kind: "timeout" });

    const cancellation = new CoinbasePublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellation.instruments("spot", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });

    const overloaded = new CoinbasePublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000, maxInFlight: 1 });
    const overloadController = new AbortController();
    const first = overloaded.instruments("spot", overloadController.signal);
    await expect(overloaded.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    overloadController.abort();
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });

    expect(() => new CoinbasePublicAdapter({ baseUrl: "https://token@api.exchange.coinbase.com" })).toThrow(/credentials/);
    expect(() => new CoinbasePublicAdapter({ maxPayloadBytes: 0 })).toThrow(/maxPayloadBytes/);
  });

  it("cancels an oversized streaming body", async () => {
    const cancelled = vi.fn();
    const adapter = new CoinbasePublicAdapter({
      maxPayloadBytes: 16,
      fetch: (async () => chunkedOversizedResponse(cancelled)) as typeof fetch
    });

    await expect(adapter.instruments("spot")).rejects.toMatchObject({ kind: "validation" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/coinbase/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>, requests: Array<{ url: URL; headers: Headers }> = []): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected Coinbase fixture URL: ${url}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL): string {
  if (url.pathname === "/products") return "products";
  const match = /^\/products\/([^/]+)\/book$/.exec(url.pathname);
  if (match) return `book:${decodeURIComponent(match[1]!)}:${url.searchParams.get("level")}`;
  return url.pathname;
}

function responseConfig(status: number, body: unknown) {
  return { status, body };
}

function isResponseConfig(value: unknown): value is { status: number; body: unknown } {
  return Boolean(value && typeof value === "object" && "status" in value && "body" in value);
}

function jsonResponse(value: unknown, status = 200): Response {
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

function chunkedOversizedResponse(cancelled: () => void): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('[{"id":"BTC-'));
        controller.enqueue(encoder.encode('USD","more":"bytes"}]'));
      },
      cancel: cancelled
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
