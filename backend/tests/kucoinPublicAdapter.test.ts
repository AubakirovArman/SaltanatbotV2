import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { validatePublicOperationResult } from "../src/venues/conformance/index.js";
import { KUCOIN_PUBLIC_CAPABILITIES, KUCOIN_PUBLIC_VENUE_PLUGIN, KucoinPublicAdapter, type KucoinPublicAdapterOptions } from "../src/venues/kucoin/index.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";

const SPOT_SYMBOLS = fixture("spot-symbols.json");
const PERPETUAL_SYMBOLS = fixture("perpetual-symbols.json");
const SPOT_ALL_TICKERS = fixture("spot-all-tickers.json");
const PERPETUAL_ALL_TICKERS = fixture("perpetual-all-tickers.json");
const SPOT_TICKER = fixture("spot-ticker.json");
const PERPETUAL_TICKER = fixture("perpetual-ticker.json");
const SPOT_DEPTH = fixture("spot-depth.json");
const PERPETUAL_DEPTH = fixture("perpetual-depth.json");
const FUNDING_CURRENT = fixture("funding-current.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("KuCoin public adapter", () => {
  it("advertises a versioned public-only Spot/perpetual plugin", () => {
    const adapter = new KucoinPublicAdapter({ fetch: routedFetch({}) });

    expectTypeOf(adapter).toMatchTypeOf<PublicVenueAdapter>();
    expectTypeOf<KucoinPublicAdapterOptions>().toBeObject();
    expect(adapter.capabilities()).toEqual(KUCOIN_PUBLIC_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      venue: "kucoin",
      publicData: true,
      spot: true,
      perpetual: true,
      funding: true,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false
    });
    expect(KUCOIN_PUBLIC_VENUE_PLUGIN).toMatchObject({
      venue: "kucoin",
      authority: "public-read-only",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });
  });

  it("normalizes Spot and only unit-proven linear USDT perpetual instruments", async () => {
    const adapter = new KucoinPublicAdapter({ now: () => 9_100, fetch: routedFetch({ spotSymbols: SPOT_SYMBOLS, perpetualSymbols: PERPETUAL_SYMBOLS }) });

    const [spot, perpetual] = await Promise.all([adapter.instruments("spot"), adapter.instruments("perpetual")]);

    expect(spot).toMatchObject({ venue: "kucoin", marketType: "spot", receivedAt: 9_100, rejectedRows: [] });
    expect(spot.instruments[0]).toMatchObject({
      id: "kucoin:spot:BTC-USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      quantityUnit: "base",
      tickSize: 0.1,
      quantityStep: 0.00000001,
      minimumQuantity: 0.00001,
      minimumNotional: 0.1,
      status: "trading"
    });
    expect(perpetual.instruments).toHaveLength(1);
    expect(perpetual.rejectedRows).toHaveLength(1);
    expect(perpetual.rejectedRows[0]?.message).toContain("inverse contracts");
    expect(perpetual.instruments[0]).toMatchObject({
      id: "kucoin:perpetual:XBTUSDTM",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      contractDirection: "linear",
      contractMultiplier: 0.001,
      contractValueCurrency: "BTC",
      quantityUnit: "contract",
      quantityStep: 1,
      fundingIntervalMinutes: 480
    });
    validatePublicOperationResult("instruments", spot, { venue: "kucoin", marketType: "spot", maxItems: 10_000 });
    validatePublicOperationResult("instruments", perpetual, { venue: "kucoin", marketType: "perpetual", maxItems: 10_000 });
  });

  it("normalizes executable bulk and single BBO with native units and timestamps", async () => {
    const requests: RequestRecord[] = [];
    const adapter = new KucoinPublicAdapter({
      now: () => 9_101,
      fetch: routedFetch({ spotAllTickers: SPOT_ALL_TICKERS, perpetualAllTickers: PERPETUAL_ALL_TICKERS, spotTicker: SPOT_TICKER, perpetualTicker: PERPETUAL_TICKER }, requests)
    });

    const [spotBulk, perpetualBulk, spot, perpetual] = await Promise.all([adapter.tickers("spot"), adapter.tickers("perpetual"), adapter.ticker("btc-usdt", "spot"), adapter.ticker("xbtusdtm", "perpetual")]);

    expect(spotBulk.tickers[0]).toMatchObject({ instrumentId: "BTC-USDT", bid: 67192.5, bidSize: 0.000025, ask: 67192.6, askSize: 1.24949204, exchangeTs: 1784023200000 });
    expect(perpetualBulk.tickers[0]).toMatchObject({ instrumentId: "XBTUSDTM", quantityUnit: "contract", bidSize: 2767, askSize: 5368, exchangeTs: 1784023200123 });
    expect(spot).toMatchObject({ instrumentId: "BTC-USDT", last: 67269, lastSize: 0.000025, exchangeTs: 1784023200100 });
    expect(perpetual).toMatchObject({ instrumentId: "XBTUSDTM", last: 67158.4, lastSize: 2936, exchangeTs: 1784023200200 });
    expect(requests.every((item) => !item.headers.has("authorization") && !item.headers.has("x-api-key"))).toBe(true);
    validatePublicOperationResult("ticker", spot, { venue: "kucoin", marketType: "spot", instrumentId: "BTC-USDT", maxItems: 1 });
  });

  it("uses bounded public partial depth endpoints and preserves sequence/time", async () => {
    const requests: RequestRecord[] = [];
    const adapter = new KucoinPublicAdapter({
      now: () => 9_102,
      fetch: routedFetch({ spotDepth: SPOT_DEPTH, perpetualDepth: PERPETUAL_DEPTH }, requests)
    });

    const [spot, perpetual] = await Promise.all([adapter.depth({ instrumentId: "BTC-USDT", marketType: "spot", limit: 2 }), adapter.depth({ instrumentId: "XBTUSDTM", marketType: "perpetual", limit: 2 })]);

    expect(spot).toMatchObject({ sequence: 14610502970, exchangeTs: 1784023200300, quantityUnit: "base", complete: true });
    expect(perpetual).toMatchObject({ sequence: 1697895963339, exchangeTs: 1784023200400, quantityUnit: "contract", complete: true });
    expect(requests.map((item) => item.url.pathname).sort()).toEqual(["/api/v1/level2/depth20", "/api/v1/market/orderbook/level2_20"]);
    validatePublicOperationResult("depth", perpetual, { venue: "kucoin", marketType: "perpetual", instrumentId: "XBTUSDTM", maxItems: 100 });
  });

  it("normalizes the proven funding interval, estimate bounds and settled history", async () => {
    const adapter = new KucoinPublicAdapter({ now: () => 1784023200500, fetch: routedFetch({ fundingCurrent: FUNDING_CURRENT, fundingHistory: FUNDING_HISTORY }) });

    const funding = await adapter.funding("XBTUSDTM", { historyLimit: 2 });

    expect(funding).toMatchObject({
      venue: "kucoin",
      instrumentId: "XBTUSDTM",
      currentEstimateRate: 0.000061,
      nextEstimateRate: 0.000109,
      fundingTime: 1784023200000,
      nextFundingTime: 1784052000000,
      intervalMinutes: 480,
      scheduleVerified: true,
      minimumRate: -0.003,
      maximumRate: 0.003,
      sourceErrors: []
    });
    expect(funding.history).toHaveLength(2);
    validatePublicOperationResult("funding", funding, { venue: "kucoin", marketType: "perpetual", instrumentId: "XBTUSDTM", maxItems: 100 });
  });

  it("fails closed on unsupported products, malformed/crossed data and bounds", async () => {
    const crossed = structuredClone(SPOT_TICKER) as any;
    crossed.data.bestBid = "70000";
    const adapter = new KucoinPublicAdapter({ fetch: routedFetch({ spotTicker: crossed }) });

    await expect(adapter.instruments("future")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.ticker("BTC-USDT", "option")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.ticker("BTC-USDT", "spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC-USDT", marketType: "spot", limit: 101 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.funding("XBTUSDTM", { historyLimit: 101 })).rejects.toMatchObject({ kind: "validation" });
  });

  it("classifies exchange/rate/HTTP/timeout/cancellation and rejects unsafe origins", async () => {
    const exchange = new KucoinPublicAdapter({ fetch: routedFetch({ spotTicker: responseConfig(400, EXCHANGE_ERROR) }) });
    const limited = new KucoinPublicAdapter({ fetch: routedFetch({ spotSymbols: responseConfig(429, { code: "429000", msg: "too many requests" }) }) });
    const failed = new KucoinPublicAdapter({ fetch: routedFetch({ spotSymbols: responseConfig(503, {}) }) });
    await expect(exchange.ticker("BTC-USDT", "spot")).rejects.toMatchObject({ kind: "exchange", status: 400 });
    await expect(limited.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    await expect(failed.instruments("spot")).rejects.toMatchObject({ kind: "http", status: 503 });

    const oversized = new KucoinPublicAdapter({ fetch: routedFetch({ spotSymbols: SPOT_SYMBOLS }), maxPayloadBytes: 16 });
    await expect(oversized.instruments("spot")).rejects.toMatchObject({ kind: "validation" });

    const timeout = new KucoinPublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeout.instruments("spot")).rejects.toMatchObject({ kind: "timeout" });
    const cancellation = new KucoinPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellation.instruments("spot", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });

    const overloaded = new KucoinPublicAdapter({ fetch: abortingFetch(), maxInFlight: 1, timeoutMs: 1_000 });
    const abortFirst = new AbortController();
    const first = overloaded.instruments("spot", abortFirst.signal);
    await expect(overloaded.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    abortFirst.abort();
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });

    expect(() => new KucoinPublicAdapter({ spotBaseUrl: "https://secret@api.kucoin.com" })).toThrow(/credentials/);
    expect(() => new KucoinPublicAdapter({ futuresBaseUrl: "ftp://api-futures.kucoin.com" })).toThrow(/HTTP or HTTPS/);
    expect(() => new KucoinPublicAdapter({ maxPayloadBytes: 0 })).toThrow(/positive integer/);
  });
});

interface RequestRecord {
  url: URL;
  headers: Headers;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/kucoin/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>, requests: RequestRecord[] = []): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected KuCoin fixture URL: ${url}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL): string {
  if (url.pathname === "/api/v2/symbols") return "spotSymbols";
  if (url.pathname === "/api/v1/contracts/active") return "perpetualSymbols";
  if (url.pathname === "/api/v1/market/allTickers") return "spotAllTickers";
  if (url.pathname === "/api/v1/allTickers") return "perpetualAllTickers";
  if (url.pathname === "/api/v1/market/orderbook/level1") return "spotTicker";
  if (url.pathname === "/api/v1/ticker") return "perpetualTicker";
  if (url.pathname.startsWith("/api/v1/market/orderbook/level2_")) return "spotDepth";
  if (url.pathname.startsWith("/api/v1/level2/depth")) return "perpetualDepth";
  if (/^\/api\/v1\/funding-rate\/[^/]+\/current$/.test(url.pathname)) return "fundingCurrent";
  if (url.pathname === "/api/v1/contract/funding-rates") return "fundingHistory";
  return url.pathname;
}

function responseConfig(status: number, body: unknown) {
  return { status, body };
}

function isResponseConfig(value: unknown): value is { status: number; body: unknown } {
  return Boolean(value && typeof value === "object" && "status" in value && "body" in value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function abortingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
}
