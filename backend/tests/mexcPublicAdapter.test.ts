import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { validatePublicOperationResult } from "../src/venues/conformance/index.js";
import { MEXC_PUBLIC_CAPABILITIES, MEXC_PUBLIC_VENUE_PLUGIN, MexcPublicAdapter, type MexcPublicAdapterOptions } from "../src/venues/mexc/index.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";

const SPOT_INSTRUMENTS = fixture("spot-exchange-info.json");
const PERPETUAL_INSTRUMENTS = fixture("perpetual-contracts.json");
const SPOT_TICKERS = fixture("spot-tickers.json");
const SPOT_TICKER = fixture("spot-ticker.json");
const SPOT_DEPTH = fixture("spot-depth.json");
const PERPETUAL_DEPTH = fixture("perpetual-depth.json");
const FUNDING_CURRENT = fixture("funding-current.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("MEXC public adapter", () => {
  it("advertises a versioned public-only Spot/perpetual plugin", () => {
    const adapter = new MexcPublicAdapter({ fetch: routedFetch({}) });

    expectTypeOf(adapter).toMatchTypeOf<PublicVenueAdapter>();
    expectTypeOf<MexcPublicAdapterOptions>().toBeObject();
    expect(adapter.capabilities()).toEqual(MEXC_PUBLIC_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      venue: "mexc",
      publicData: true,
      spot: true,
      perpetual: true,
      funding: true,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false
    });
    expect(MEXC_PUBLIC_VENUE_PLUGIN).toMatchObject({
      venue: "mexc",
      authority: "public-read-only",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });
  });

  it("normalizes documented Spot precision/minima and perpetual contract units", async () => {
    const requests: RequestRecord[] = [];
    const adapter = new MexcPublicAdapter({ now: () => 9_200, fetch: routedFetch({ spotInstruments: SPOT_INSTRUMENTS, perpetualInstruments: PERPETUAL_INSTRUMENTS }, requests) });

    const [spot, perpetual] = await Promise.all([adapter.instruments("spot"), adapter.instruments("perpetual")]);

    expect(spot.instruments[0]).toMatchObject({
      id: "mexc:spot:BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      quantityUnit: "base",
      tickSize: 0.01,
      quantityStep: 0.00000001,
      minimumQuantity: 0.0001,
      minimumNotional: 5,
      status: "trading"
    });
    expect(perpetual.instruments[0]).toMatchObject({
      id: "mexc:perpetual:BTC_USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      contractDirection: "linear",
      contractMultiplier: 0.0001,
      contractValueCurrency: "BTC",
      quantityUnit: "contract",
      tickSize: 0.5,
      quantityStep: 1,
      minimumQuantity: 1,
      status: "trading"
    });
    expect(requests.every((item) => item.url.origin === "https://api.mexc.com")).toBe(true);
    expect(requests.every((item) => !item.headers.has("authorization") && !item.headers.has("x-mexc-apikey"))).toBe(true);
    validatePublicOperationResult("instruments", spot, { venue: "mexc", marketType: "spot", maxItems: 10_000 });
    validatePublicOperationResult("instruments", perpetual, { venue: "mexc", marketType: "perpetual", maxItems: 10_000 });
  });

  it("publishes executable Spot bulk/single BBO and derives perpetual BBO from depth", async () => {
    const adapter = new MexcPublicAdapter({
      now: () => 1784023200200,
      fetch: routedFetch({ spotTickers: SPOT_TICKERS, spotTicker: SPOT_TICKER, perpetualDepth: PERPETUAL_DEPTH })
    });

    const [bulk, spot, perpetual] = await Promise.all([adapter.tickers("spot"), adapter.ticker("btcusdt", "spot"), adapter.ticker("btc_usdt", "perpetual")]);

    expect(bulk.tickers[0]).toMatchObject({ instrumentId: "BTCUSDT", bid: 67000.1, bidSize: 1.2, ask: 67000.2, askSize: 2.3, exchangeTs: 1784023200200 });
    expect(spot).toMatchObject({ instrumentId: "BTCUSDT", quantityUnit: "base", bidSize: 1.2, askSize: 2.3 });
    expect(perpetual).toMatchObject({ instrumentId: "BTC_USDT", quantityUnit: "contract", bid: 67000.1, bidSize: 120, ask: 67000.2, askSize: 230, exchangeTs: 1784023200100 });
    validatePublicOperationResult("ticker", perpetual, { venue: "mexc", marketType: "perpetual", instrumentId: "BTC_USDT", maxItems: 1 });
  });

  it("normalizes bounded Spot/perpetual REST depth with distinct sequence fields", async () => {
    const adapter = new MexcPublicAdapter({
      now: () => 1784023200200,
      fetch: routedFetch({ spotDepth: SPOT_DEPTH, perpetualDepth: PERPETUAL_DEPTH })
    });

    const [spot, perpetual] = await Promise.all([adapter.depth({ instrumentId: "BTCUSDT", marketType: "spot", limit: 2 }), adapter.depth({ instrumentId: "BTC_USDT", marketType: "perpetual", limit: 2 })]);

    expect(spot).toMatchObject({ sequence: 10589632359, exchangeTs: 1784023200200, quantityUnit: "base", complete: true });
    expect(perpetual).toMatchObject({ sequence: 96801927, exchangeTs: 1784023200100, quantityUnit: "contract", complete: true });
    expect(perpetual.bids[0]).toEqual([67000.1, 120, 3]);
    validatePublicOperationResult("depth", spot, { venue: "mexc", marketType: "spot", instrumentId: "BTCUSDT", maxItems: 500 });
  });

  it("normalizes the documented futures funding cycle and settled history", async () => {
    const adapter = new MexcPublicAdapter({ now: () => 1783994400200, fetch: routedFetch({ fundingCurrent: FUNDING_CURRENT, fundingHistory: FUNDING_HISTORY }) });

    const funding = await adapter.funding("btc_usdt", { historyLimit: 2 });

    expect(funding).toMatchObject({
      venue: "mexc",
      instrumentId: "BTC_USDT",
      currentEstimateRate: -0.000489,
      fundingTime: 1784023200000,
      nextFundingTime: 1784052000000,
      intervalMinutes: 480,
      scheduleVerified: true,
      minimumRate: -0.001,
      maximumRate: 0.001,
      sourceErrors: []
    });
    expect(funding.history).toHaveLength(2);
    validatePublicOperationResult("funding", funding, { venue: "mexc", marketType: "perpetual", instrumentId: "BTC_USDT", maxItems: 100 });
  });

  it("does not fake bulk futures sizes or unsupported markets and rejects malformed bounds", async () => {
    const crossed = structuredClone(SPOT_TICKER) as any;
    crossed.bidPrice = "70000";
    const adapter = new MexcPublicAdapter({ fetch: routedFetch({ spotTicker: crossed }) });

    await expect(adapter.tickers("perpetual")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.instruments("future")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(adapter.ticker("BTCUSDT", "spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTCUSDT", marketType: "spot", limit: 501 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.funding("BTC_USDT", { historyLimit: 101 })).rejects.toMatchObject({ kind: "validation" });
  });

  it("classifies exchange/rate/HTTP/timeout/cancellation and rejects unsafe origins", async () => {
    const exchange = new MexcPublicAdapter({ fetch: routedFetch({ perpetualInstruments: responseConfig(400, EXCHANGE_ERROR) }) });
    const limited = new MexcPublicAdapter({ fetch: routedFetch({ spotInstruments: responseConfig(429, { code: 429, msg: "slow down" }) }) });
    const failed = new MexcPublicAdapter({ fetch: routedFetch({ spotInstruments: responseConfig(503, {}) }) });
    await expect(exchange.instruments("perpetual")).rejects.toMatchObject({ kind: "exchange", status: 400 });
    await expect(limited.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    await expect(failed.instruments("spot")).rejects.toMatchObject({ kind: "http", status: 503 });

    const oversized = new MexcPublicAdapter({ fetch: routedFetch({ spotInstruments: SPOT_INSTRUMENTS }), maxPayloadBytes: 16 });
    await expect(oversized.instruments("spot")).rejects.toMatchObject({ kind: "validation" });

    const timeout = new MexcPublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeout.instruments("spot")).rejects.toMatchObject({ kind: "timeout" });
    const cancellation = new MexcPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellation.instruments("spot", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });

    const overloaded = new MexcPublicAdapter({ fetch: abortingFetch(), maxInFlight: 1, timeoutMs: 1_000 });
    const firstController = new AbortController();
    const first = overloaded.instruments("spot", firstController.signal);
    await expect(overloaded.instruments("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    firstController.abort();
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });

    expect(() => new MexcPublicAdapter({ baseUrl: "https://key@api.mexc.com" })).toThrow(/credentials/);
    expect(() => new MexcPublicAdapter({ baseUrl: "https://api.mexc.com/path" })).toThrow(/origin/);
    expect(() => new MexcPublicAdapter({ maxInFlight: 0 })).toThrow(/positive integer/);
  });
});

interface RequestRecord {
  url: URL;
  headers: Headers;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/mexc/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>, requests: RequestRecord[] = []): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected MEXC fixture URL: ${url}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL): string {
  if (url.pathname === "/api/v3/exchangeInfo") return "spotInstruments";
  if (url.pathname === "/api/v1/contract/detail") return "perpetualInstruments";
  if (url.pathname === "/api/v3/ticker/bookTicker") return url.searchParams.has("symbol") ? "spotTicker" : "spotTickers";
  if (url.pathname === "/api/v3/depth") return "spotDepth";
  if (/^\/api\/v1\/contract\/depth\/[^/]+$/.test(url.pathname)) return "perpetualDepth";
  if (url.pathname === "/api/v1/contract/funding_rate/history") return "fundingHistory";
  if (/^\/api\/v1\/contract\/funding_rate\/[^/]+$/.test(url.pathname)) return "fundingCurrent";
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
