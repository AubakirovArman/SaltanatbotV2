import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { KRAKEN_PUBLIC_CAPABILITIES, KRAKEN_PUBLIC_VENUE_PLUGIN, KrakenPublicAdapter, type KrakenPublicAdapterOptions } from "../src/venues/kraken/index.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";
import { validatePublicOperationResult } from "../src/venues/conformance/index.js";

const SPOT_INSTRUMENTS = fixture("spot-instruments.json");
const SPOT_TICKERS = fixture("spot-tickers.json");
const SPOT_DEPTH = fixture("spot-depth.json");
const FUTURES_INSTRUMENTS = fixture("futures-instruments.json");
const FUTURES_TICKERS = fixture("futures-tickers.json");
const FUTURES_DEPTH = fixture("futures-depth.json");
const FUNDING_HISTORY = fixture("funding-history.json");

describe("Kraken public adapter", () => {
  it("advertises only credential-free implemented scopes and a versioned public plugin", () => {
    const adapter = new KrakenPublicAdapter({ fetch: routedFetch({}) });

    expectTypeOf(adapter).toMatchTypeOf<PublicVenueAdapter>();
    expectTypeOf<KrakenPublicAdapterOptions>().toBeObject();
    expect(adapter.capabilities()).toEqual(KRAKEN_PUBLIC_CAPABILITIES);
    expect(adapter.capabilities()).toMatchObject({
      venue: "kraken",
      publicData: true,
      spot: true,
      perpetual: true,
      datedFuture: true,
      funding: true,
      privateExecution: false,
      borrow: false,
      depositWithdrawal: false
    });
    expect(KRAKEN_PUBLIC_VENUE_PLUGIN).toMatchObject({
      venue: "kraken",
      authority: "public-read-only",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });
  });

  it("normalizes Spot plus inverse and linear perpetual/future identity and native units", async () => {
    const requested: URL[] = [];
    const adapter = new KrakenPublicAdapter({
      now: () => 9_000,
      fetch: routedFetch(
        {
          "spot-instruments": SPOT_INSTRUMENTS,
          "futures-instruments": FUTURES_INSTRUMENTS
        },
        requested
      )
    });

    const [spot, perpetuals, futures] = await Promise.all([adapter.instruments("spot"), adapter.instruments("perpetual"), adapter.instruments("future")]);

    expect(spot).toMatchObject({ venue: "kraken", marketType: "spot", receivedAt: 9_000, rejectedRows: [] });
    expect(spot.instruments[0]).toMatchObject({
      id: "kraken:spot:BTC/USD",
      venueSymbol: "BTC/USD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      settleAsset: "USD",
      quantityUnit: "base",
      tickSize: 0.1,
      quantityStep: 0.00000001,
      minimumQuantity: 0.00005,
      minimumNotional: 0.5
    });
    expect(perpetuals.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "kraken:perpetual:PI_XBTUSD",
          baseAsset: "BTC",
          contractDirection: "inverse",
          settleAsset: "BTC",
          contractValue: 1,
          contractValueCurrency: "USD",
          quantityUnit: "contract",
          quantityStep: 1,
          fundingIntervalMinutes: 60
        }),
        expect.objectContaining({
          id: "kraken:perpetual:PF_XBTUSD",
          baseAsset: "BTC",
          contractDirection: "linear",
          settleAsset: "USD",
          contractValueCurrency: "BTC",
          quantityUnit: "base",
          quantityStep: 0.0001,
          fundingIntervalMinutes: 60
        })
      ])
    );
    expect(futures.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "kraken:future:FI_XBTUSD_260925",
          contractDirection: "inverse",
          quantityUnit: "contract",
          expiryTime: Date.parse("2026-09-25T16:00:00.000Z")
        }),
        expect.objectContaining({
          id: "kraken:future:FF_XBTUSD_260925",
          contractDirection: "linear",
          quantityUnit: "base",
          expiryTime: Date.parse("2026-09-25T08:00:00.000Z")
        })
      ])
    );
    validatePublicOperationResult("instruments", spot, { venue: "kraken", marketType: "spot", maxItems: 5_000 });
    validatePublicOperationResult("instruments", perpetuals, { venue: "kraken", marketType: "perpetual", maxItems: 5_000 });
    validatePublicOperationResult("instruments", futures, { venue: "kraken", marketType: "future", maxItems: 5_000 });
    expect(requested.find((url) => url.pathname.endsWith("/instruments"))?.searchParams.getAll("contractType")).toEqual(["futures_inverse", "flexible_futures"]);
  });

  it("normalizes bulk and selected top books without inventing a Spot exchange timestamp", async () => {
    const requested: URL[] = [];
    const adapter = new KrakenPublicAdapter({
      now: () => 9_001,
      fetch: routedFetch(
        {
          "spot-tickers": SPOT_TICKERS,
          "spot-ticker:BTC/USD": singleSpotTicker("BTC/USD"),
          "futures-tickers": FUTURES_TICKERS,
          "futures-ticker:PI_XBTUSD": FUTURES_TICKERS
        },
        requested
      )
    });

    const [spot, selectedSpot, perpetuals, selectedPerpetual] = await Promise.all([adapter.tickers("spot"), adapter.ticker("xbt/usd", "spot"), adapter.tickers("perpetual"), adapter.ticker("pi_xbtusd", "perpetual")]);

    expect(spot.tickers).toHaveLength(2);
    expect(spot.tickers[0]).toMatchObject({
      instrumentId: "BTC/USD",
      quantityUnit: "base",
      bid: 64544.21,
      bidSize: 0.74743612,
      ask: 64544.22,
      askSize: 1.67198587,
      last: 64544.21,
      lastSize: 0.002,
      volume24h: 222.5,
      exchangeTs: 9_001,
      receivedAt: 9_001
    });
    expect(selectedSpot).toEqual(spot.tickers[0]);
    expect(perpetuals.tickers).toEqual(expect.arrayContaining([expect.objectContaining({ instrumentId: "PI_XBTUSD", quantityUnit: "contract", bidSize: 1000 }), expect.objectContaining({ instrumentId: "PF_XBTUSD", quantityUnit: "base", bidSize: 2.5 })]));
    expect(selectedPerpetual).toMatchObject({
      instrumentId: "PI_XBTUSD",
      exchangeTs: Date.parse("2026-07-14T12:34:56.000Z")
    });
    expect(requested.find((url) => url.pathname.endsWith("/Ticker") && url.searchParams.has("pair"))?.searchParams.get("assetVersion")).toBe("1");
  });

  it("returns bounded complete REST depth with explicit unsequenced semantics", async () => {
    const requested: URL[] = [];
    const adapter = new KrakenPublicAdapter({
      now: () => 9_002,
      fetch: routedFetch(
        {
          "spot-depth:BTC/USD": SPOT_DEPTH,
          "futures-depth:PI_XBTUSD": FUTURES_DEPTH,
          "futures-depth:PF_XBTUSD": FUTURES_DEPTH
        },
        requested
      )
    });

    const [spot, inverse, linear] = await Promise.all([adapter.depth({ instrumentId: "BTC/USD", marketType: "spot", limit: 2 }), adapter.depth({ instrumentId: "PI_XBTUSD", marketType: "perpetual", limit: 2 }), adapter.depth({ instrumentId: "PF_XBTUSD", marketType: "perpetual", limit: 2 })]);

    expect(spot).toMatchObject({ quantityUnit: "base", sequence: 0, complete: true, exchangeTs: 1_784_024_000_200 });
    expect(spot.bids).toEqual([
      [64544.21, 0.74],
      [64544.1, 1.1]
    ]);
    expect(inverse).toMatchObject({ quantityUnit: "contract", sequence: 0, complete: true });
    expect(linear).toMatchObject({ quantityUnit: "base", sequence: 0, complete: true });
    expect(inverse.bids).toHaveLength(2);
    expect(requested.find((url) => url.pathname.endsWith("/Depth"))?.searchParams.get("count")).toBe("2");
    validatePublicOperationResult("depth", inverse, {
      venue: "kraken",
      marketType: "perpetual",
      instrumentId: "PI_XBTUSD",
      maxItems: 500
    });
  });

  it("converts inverse absolute funding into relative rates and preserves settled history", async () => {
    const adapter = new KrakenPublicAdapter({
      now: () => 9_003,
      fetch: routedFetch({
        "futures-ticker:PI_XBTUSD": FUTURES_TICKERS,
        "funding-history:PI_XBTUSD": FUNDING_HISTORY
      })
    });

    const funding = await adapter.funding("PI_XBTUSD", { historyLimit: 1 });

    expect(funding).toMatchObject({
      venue: "kraken",
      instrumentId: "PI_XBTUSD",
      currentEstimateRate: 0.0001,
      nextEstimateRate: 0.00008,
      settledRate: 0.00011,
      fundingTime: Date.parse("2026-07-14T13:00:00.000Z"),
      nextFundingTime: Date.parse("2026-07-14T14:00:00.000Z"),
      intervalMinutes: 60,
      scheduleVerified: true,
      formulaType: "inverse-absolute-times-index",
      method: "continuous-hourly",
      sourceErrors: [],
      receivedAt: 9_003
    });
    expect(funding.history).toEqual([expect.objectContaining({ fundingRate: 0.00011, realizedRate: 0.00011, method: "settled" })]);
    validatePublicOperationResult("funding", funding, {
      venue: "kraken",
      marketType: "perpetual",
      instrumentId: "PI_XBTUSD",
      maxItems: 100
    });

    const historyFailure = new KrakenPublicAdapter({
      fetch: routedFetch({
        "futures-ticker:PI_XBTUSD": FUTURES_TICKERS,
        "funding-history:PI_XBTUSD": responseConfig(503, {})
      })
    });
    await expect(historyFailure.funding("PI_XBTUSD")).resolves.toMatchObject({
      currentEstimateRate: 0.0001,
      history: [],
      sourceErrors: [expect.stringContaining("HTTP 503")]
    });
    await expect(adapter.funding("PF_XBTUSD")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("fails closed on malformed identity, crossed books and unsupported quantity units", async () => {
    const malformedInstruments = structuredClone(FUTURES_INSTRUMENTS) as any;
    malformedInstruments.instruments = [
      {
        ...malformedInstruments.instruments[0],
        type: "futures_vanilla",
        symbol: "FV_XBTUSD"
      }
    ];
    const crossed = structuredClone(FUTURES_TICKERS) as any;
    crossed.tickers = [{ ...crossed.tickers[0], bid: 10, ask: 9 }];
    const unsorted = structuredClone(FUTURES_DEPTH) as any;
    unsorted.orderBook.bids = [
      [9, 1],
      [10, 1]
    ];
    const adapter = new KrakenPublicAdapter({
      fetch: routedFetch({
        "futures-instruments": malformedInstruments,
        "futures-tickers": crossed,
        "futures-depth:PI_XBTUSD": unsorted
      })
    });

    await expect(adapter.instruments("perpetual")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.tickers("perpetual")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "PI_XBTUSD", marketType: "perpetual" })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.depth({ instrumentId: "PI_XBTUSD", marketType: "perpetual", limit: 501 })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.instruments("option")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("classifies exchange/rate/timeout/cancellation and rejects unsafe transport options", async () => {
    const exchange = new KrakenPublicAdapter({
      fetch: routedFetch({ "spot-tickers": { error: ["EGeneral:Invalid arguments"], result: {} } })
    });
    const limited = new KrakenPublicAdapter({ fetch: routedFetch({ "spot-tickers": responseConfig(429, {}) }) });
    await expect(exchange.tickers("spot")).rejects.toMatchObject({ kind: "exchange" });
    await expect(limited.tickers("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });

    const timeout = new KrakenPublicAdapter({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timeout.tickers("spot")).rejects.toMatchObject({ kind: "timeout" });

    const cancellation = new KrakenPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancellation.tickers("spot", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });

    const overloaded = new KrakenPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000, maxInFlight: 1 });
    const overloadController = new AbortController();
    const first = overloaded.tickers("spot", overloadController.signal);
    await expect(overloaded.tickers("spot")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });
    overloadController.abort();
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });

    expect(() => new KrakenPublicAdapter({ spotBaseUrl: "https://user:secret@api.kraken.com" })).toThrow(/credentials/);
    expect(() => new KrakenPublicAdapter({ maxInFlight: 0 })).toThrow(/maxInFlight/);
  });

  it("cancels an oversized streaming body", async () => {
    const cancelled = vi.fn();
    const adapter = new KrakenPublicAdapter({
      maxPayloadBytes: 16,
      fetch: (async () => chunkedOversizedResponse(cancelled)) as typeof fetch
    });

    await expect(adapter.tickers("spot")).rejects.toMatchObject({ kind: "validation" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/kraken/${name}`, import.meta.url), "utf8"));
}

function singleSpotTicker(id: string): unknown {
  const fixtureValue = SPOT_TICKERS as { error: unknown[]; result: Record<string, unknown> };
  return { error: [], result: { [id]: fixtureValue.result[id] } };
}

function routedFetch(routes: Record<string, unknown>, requested: URL[] = []): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    const key = routeKey(url);
    if (!(key in routes)) throw new Error(`Unexpected Kraken fixture URL: ${url}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
}

function routeKey(url: URL): string {
  if (url.pathname.endsWith("/AssetPairs")) return "spot-instruments";
  if (url.pathname.endsWith("/Ticker")) {
    const pair = url.searchParams.get("pair");
    return pair ? `spot-ticker:${pair}` : "spot-tickers";
  }
  if (url.pathname.endsWith("/Depth")) return `spot-depth:${url.searchParams.get("pair")}`;
  if (url.pathname.endsWith("/instruments")) return "futures-instruments";
  if (url.pathname.endsWith("/tickers")) {
    const symbol = url.searchParams.get("symbol");
    return symbol ? `futures-ticker:${symbol}` : "futures-tickers";
  }
  if (url.pathname.endsWith("/orderbook")) return `futures-depth:${url.searchParams.get("symbol")}`;
  if (url.pathname.endsWith("/historical-funding-rates")) return `funding-history:${url.searchParams.get("symbol")}`;
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
        controller.enqueue(encoder.encode('{"error":[],"'));
        controller.enqueue(encoder.encode('result":{"more":"bytes"}}'));
      },
      cancel: cancelled
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
