import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GatePublicAdapter } from "../src/venues/gate/adapter.js";

const SPOT_INSTRUMENTS = fixture("instruments-spot.json");
const PERPETUAL_INSTRUMENTS = fixture("instruments-perpetual.json");
const SPOT_TICKERS = fixture("tickers-spot.json");
const PERPETUAL_TICKERS = fixture("tickers-perpetual.json");
const SPOT_DEPTH = fixture("depth-spot.json");
const PERPETUAL_DEPTH = fixture("depth-perpetual.json");
const FUNDING_CURRENT = fixture("funding-current.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("Gate public adapter conformance", () => {
  it("advertises only implemented credential-free capabilities", () => {
    const capabilities = new GatePublicAdapter({ fetch: routedFetch({}) }).capabilities();

    expect(capabilities).toEqual({
      venue: "gate",
      publicData: true,
      spot: true,
      margin: false,
      perpetual: true,
      datedFuture: false,
      option: false,
      nativeSpread: false,
      topBook: true,
      depth: true,
      publicTrades: false,
      funding: true,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false,
      demoEnvironment: false
    });
  });

  it("normalizes SPOT and direct USDT perpetual contract rules", async () => {
    const adapter = new GatePublicAdapter({
      now: () => 1_784_030_700_000,
      fetch: routedFetch({ "instruments:spot": SPOT_INSTRUMENTS, "instruments:perpetual": PERPETUAL_INSTRUMENTS })
    });

    const [spot, perpetual] = await Promise.all([adapter.instruments("spot"), adapter.instruments("perpetual")]);

    expect(spot).toMatchObject({ venue: "gate", marketType: "spot", receivedAt: 1_784_030_700_000, rejectedRows: [] });
    expect(spot.instruments[0]).toEqual({
      id: "gate:spot:BTC_USDT",
      assetId: "BTC",
      venue: "gate",
      venueSymbol: "BTC_USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      marketType: "spot",
      contractMultiplier: 1,
      quantityUnit: "base",
      tickSize: 0.1,
      quantityStep: 0.000001,
      minimumQuantity: 0.000001,
      minimumNotional: 3,
      status: "trading"
    });
    expect(perpetual.instruments[0]).toMatchObject({
      id: "gate:perpetual:BTC_USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT",
      marketType: "perpetual",
      contractDirection: "linear",
      contractMultiplier: 0.0001,
      contractValue: 0.0001,
      contractValueCurrency: "BTC",
      quantityUnit: "contract",
      tickSize: 0.1,
      quantityStep: 1,
      minimumQuantity: 1,
      minimumNotional: 0,
      fundingIntervalMinutes: 480,
      status: "trading"
    });
  });

  it("normalizes executable perpetual all/single and SPOT single top books", async () => {
    const now = 1_784_030_701_000;
    const adapter = new GatePublicAdapter({
      now: () => now,
      fetch: routedFetch({
        "ticker:spot:BTC_USDT": SPOT_TICKERS,
        "tickers:perpetual": PERPETUAL_TICKERS,
        "ticker:perpetual:BTC_USDT": PERPETUAL_TICKERS
      })
    });

    const [spot, perpetuals, perpetual] = await Promise.all([
      adapter.ticker("btc_usdt", "spot"),
      adapter.tickers("perpetual"),
      adapter.ticker("btc_usdt", "perpetual")
    ]);

    expect(spot).toMatchObject({
      instrumentId: "BTC_USDT",
      marketType: "spot",
      quantityUnit: "base",
      bid: 62815.1,
      bidSize: 8.575012,
      ask: 62815.2,
      askSize: 14.316492,
      last: 62815.1,
      volume24h: 7332.078802,
      volumeCurrency24h: 457900375.6546521,
      exchangeTs: now,
      receivedAt: now
    });
    expect(perpetuals.tickers[0]).toMatchObject({
      instrumentId: "BTC_USDT",
      marketType: "perpetual",
      quantityUnit: "contract",
      bid: 62792,
      bidSize: 19801,
      ask: 62792.1,
      askSize: 52790,
      volume24h: 606659039,
      volumeCurrency24h: 3785952326
    });
    expect(perpetual).toEqual(perpetuals.tickers[0]);
  });

  it("normalizes bounded complete SPOT and perpetual depth with native timestamps", async () => {
    const adapter = new GatePublicAdapter({
      now: () => 1_784_030_702_000,
      fetch: routedFetch({ "depth:spot:BTC_USDT": SPOT_DEPTH, "depth:perpetual:BTC_USDT": PERPETUAL_DEPTH })
    });

    const [spot, perpetual] = await Promise.all([
      adapter.depth({ instrumentId: "BTC_USDT", marketType: "spot", limit: 2 }),
      adapter.depth({ instrumentId: "BTC_USDT", marketType: "perpetual", limit: 2 })
    ]);

    expect(spot).toMatchObject({
      venue: "gate",
      instrumentId: "BTC_USDT",
      marketType: "spot",
      quantityUnit: "base",
      sequence: 38647283849,
      exchangeTs: 1784030687869,
      complete: true
    });
    expect(spot.bids).toEqual([
      [62822.2, 0.130972],
      [62816.2, 0.000123]
    ]);
    expect(perpetual).toMatchObject({
      marketType: "perpetual",
      quantityUnit: "contract",
      sequence: 119650404292,
      exchangeTs: 1784030692527
    });
    expect(perpetual.asks).toEqual([
      [62790.9, 40010],
      [62791, 451]
    ]);
  });

  it("derives a verified funding schedule and preserves settled history", async () => {
    const seen: URL[] = [];
    const adapter = new GatePublicAdapter({
      now: () => 1_784_030_703_000,
      fetch: routedFetch({ "funding-current": FUNDING_CURRENT, "funding-history": FUNDING_HISTORY }, seen)
    });

    const funding = await adapter.funding("btc_usdt", { historyLimit: 250 });

    expect(funding).toMatchObject({
      venue: "gate",
      instrumentId: "BTC_USDT",
      currentEstimateRate: -0.000015,
      nextEstimateRate: -0.000015,
      fundingTime: 1784044800000,
      nextFundingTime: 1784073600000,
      intervalMinutes: 480,
      scheduleVerified: true,
      formulaType: "gate-perpetual",
      exchangeTs: 1_784_030_703_000,
      receivedAt: 1_784_030_703_000,
      sourceErrors: []
    });
    expect(funding.history).toEqual([
      expect.objectContaining({ fundingTime: 1783987201000, fundingRate: 0.000087, realizedRate: 0.000087 }),
      expect.objectContaining({ fundingTime: 1784016001000, fundingRate: 0.000005, realizedRate: 0.000005 })
    ]);
    expect(seen.find((url) => url.pathname.endsWith("/funding_rate"))?.searchParams.get("limit")).toBe("100");
  });

  it("keeps current funding when history fails and rejects unverifiable contract units", async () => {
    const adapter = new GatePublicAdapter({
      fetch: routedFetch({ "funding-current": FUNDING_CURRENT, "funding-history": { status: 503, body: {} } })
    });
    const funding = await adapter.funding("BTC_USDT");
    expect(funding.currentEstimateRate).toBe(-0.000015);
    expect(funding.history).toEqual([]);
    expect(funding.sourceErrors[0]).toContain("HTTP 503");

    const decimalContract = [{ ...(PERPETUAL_INSTRUMENTS as Record<string, unknown>[])[0], enable_decimal: true, order_size_min: "0.1" }];
    const decimalAdapter = new GatePublicAdapter({ fetch: routedFetch({ "instruments:perpetual": decimalContract }) });
    await expect(decimalAdapter.instruments("perpetual")).rejects.toMatchObject({ kind: "validation" });

    const wrongSettle = [{ ...(PERPETUAL_INSTRUMENTS as Record<string, unknown>[])[0], settle_currency: "BTC" }];
    const wrongSettleAdapter = new GatePublicAdapter({ fetch: routedFetch({ "instruments:perpetual": wrongSettle }) });
    await expect(wrongSettleAdapter.instruments("perpetual")).rejects.toMatchObject({ kind: "validation" });
  });

  it("fails closed on invalid books, missing executable sizes and unsupported products", async () => {
    const crossedTicker = [{ contract: "BTC_USDT", highest_bid: "10", highest_size: "1", lowest_ask: "9", lowest_size: "1" }];
    const unsortedDepth = { id: 1, update: 1784030692.5, bids: [{ p: "9", s: "1" }, { p: "10", s: "1" }], asks: [{ p: "11", s: "1" }] };
    const adapter = new GatePublicAdapter({ fetch: routedFetch({ "tickers:perpetual": crossedTicker, "depth:perpetual:BTC_USDT": unsortedDepth }) });

    await expect(adapter.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC_USDT", marketType: "perpetual" })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "BTC_USDT", marketType: "spot", limit: 101 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.instruments("future")).rejects.toMatchObject({ kind: "unsupported" });

    const missingSizeAdapter = new GatePublicAdapter({ fetch: routedFetch({ "ticker:spot:BTC_USDT": [{ currency_pair: "BTC_USDT", highest_bid: "9", lowest_ask: "10" }] }) });
    await expect(missingSizeAdapter.ticker("BTC_USDT", "spot")).rejects.toMatchObject({ kind: "validation" });
    await expect(missingSizeAdapter.tickers("spot")).rejects.toMatchObject({ kind: "unsupported" });

    const mixedSpot = [...(SPOT_INSTRUMENTS as Record<string, unknown>[]), { id: "BAD_USDT", base: "BAD", quote: "USDT", precision: 99, amount_precision: 1, trade_status: "tradable" }];
    const mixedAdapter = new GatePublicAdapter({ fetch: routedFetch({ "instruments:spot": mixedSpot }) });
    const quarantined = await mixedAdapter.instruments("spot");
    expect(quarantined.instruments).toHaveLength(1);
    expect(quarantined.rejectedRows).toEqual([expect.objectContaining({ index: 1, instrumentId: "BAD_USDT" })]);

    const unverifiableFunding = { ...(FUNDING_CURRENT as Record<string, unknown>), funding_interval: 61 };
    const fundingAdapter = new GatePublicAdapter({ fetch: routedFetch({ "funding-current": unverifiableFunding, "funding-history": FUNDING_HISTORY }) });
    await expect(fundingAdapter.funding("BTC_USDT")).rejects.toMatchObject({ kind: "validation" });
  });

  it("classifies exchange, rate, HTTP, malformed, timeout and cancellation failures", async () => {
    const exchange = new GatePublicAdapter({ fetch: routedFetch({ "tickers:perpetual": { status: 400, body: EXCHANGE_ERROR } }) });
    const rate = new GatePublicAdapter({ fetch: routedFetch({ "tickers:perpetual": { status: 429, body: { label: "TOO_MANY_REQUESTS", message: "rate limit exceeded" } } }) });
    const http = new GatePublicAdapter({ fetch: routedFetch({ "tickers:perpetual": { status: 503, body: {} } }) });
    const malformed = new GatePublicAdapter({ fetch: routedFetch({ "tickers:perpetual": new Response("not-json", { status: 200 }) }) });

    await expect(exchange.tickers("perpetual")).rejects.toMatchObject({ kind: "exchange", status: 400 });
    await expect(rate.tickers("perpetual")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    await expect(http.tickers("perpetual")).rejects.toMatchObject({ kind: "http", status: 503 });
    await expect(malformed.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });

    const oversized = new GatePublicAdapter({
      maxPayloadBytes: 10,
      fetch: routedFetch({ "tickers:perpetual": new Response("[]", { status: 200, headers: { "content-length": "11" } }) })
    });
    await expect(oversized.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });

    const oversizedActual = new GatePublicAdapter({
      maxPayloadBytes: 10,
      fetch: routedFetch({ "tickers:perpetual": new Response('[{"size":"large"}]', { status: 200 }) })
    });
    await expect(oversizedActual.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });

    const timeout = new GatePublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeout.tickers("perpetual")).rejects.toMatchObject({ kind: "timeout" });

    const cancellation = new GatePublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellation.tickers("perpetual", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/gate/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>, seen: URL[] = []): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    seen.push(url);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init?.headers).has("KEY")).toBe(false);
    expect(new Headers(init?.headers).has("SIGN")).toBe(false);
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected Gate fixture URL: ${url}`);
    const configured = routes[key];
    if (configured instanceof Response) return configured;
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL) {
  if (url.pathname === "/api/v4/spot/currency_pairs") return "instruments:spot";
  if (url.pathname === "/api/v4/futures/usdt/contracts") return "instruments:perpetual";
  if (url.pathname.startsWith("/api/v4/futures/usdt/contracts/")) return "funding-current";
  if (url.pathname === "/api/v4/futures/usdt/funding_rate") return "funding-history";
  if (url.pathname.endsWith("/spot/tickers")) return url.searchParams.has("currency_pair") ? `ticker:spot:${url.searchParams.get("currency_pair")}` : "tickers:spot";
  if (url.pathname.endsWith("/futures/usdt/tickers")) return url.searchParams.has("contract") ? `ticker:perpetual:${url.searchParams.get("contract")}` : "tickers:perpetual";
  if (url.pathname.endsWith("/spot/order_book")) return `depth:spot:${url.searchParams.get("currency_pair")}`;
  if (url.pathname.endsWith("/futures/usdt/order_book")) return `depth:perpetual:${url.searchParams.get("contract")}`;
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
