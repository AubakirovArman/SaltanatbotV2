import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HyperliquidPublicAdapter } from "../src/venues/hyperliquid/adapter.js";

const PERP_METADATA = fixture("perp-meta-contexts.json");
const SPOT_METADATA = fixture("spot-meta-contexts.json");
const BTC_BOOK = fixture("l2-btc.json");
const SPOT_107_BOOK = fixture("l2-spot-107.json");
const PURR_BOOK = fixture("l2-purr.json");
const PREDICTED_FUNDINGS = fixture("predicted-fundings.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");
const NOW = 1_784_020_000_000;

describe("Hyperliquid public adapter conformance", () => {
  it("advertises public HyperCore coverage without wallet or private authority", () => {
    const capabilities = adapter({}).capabilities();

    expect(capabilities).toMatchObject({
      venue: "hyperliquid",
      publicData: true,
      spot: true,
      perpetual: true,
      topBook: true,
      depth: true,
      funding: true,
      demoEnvironment: true,
      margin: false,
      datedFuture: false,
      option: false,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false
    });
  });

  it("keeps mainnet and testnet origins explicit", async () => {
    let requestedUrl = "";
    const client = new HyperliquidPublicAdapter({
      network: "testnet",
      now: () => NOW,
      fetch: (async (input) => {
        requestedUrl = String(input);
        return jsonResponse(PERP_METADATA);
      }) as typeof fetch
    });

    const snapshot = await client.instruments("perpetual");

    expect(requestedUrl).toBe("https://api.hyperliquid-testnet.xyz/info");
    expect(snapshot.network).toBe("testnet");
    expect(snapshot.instruments[0]?.id).toContain("hyperliquid:testnet:");
  });

  it("normalizes perp size/price rules, quanto settlement and explicit delist state", async () => {
    const snapshot = await adapter({ metaAndAssetCtxs: PERP_METADATA }).instruments("perpetual");
    const btc = snapshot.instruments.find((instrument) => instrument.apiCoin === "BTC");
    const loom = snapshot.instruments.find((instrument) => instrument.apiCoin === "LOOM");

    expect(snapshot).toMatchObject({ venue: "hyperliquid", network: "mainnet", marketType: "perpetual", receivedAt: NOW });
    expect(btc).toMatchObject({
      id: "hyperliquid:mainnet:perpetual:BTC",
      assetId: "BTC",
      venueSymbol: "BTC",
      assetIndex: 0,
      baseAsset: "BTC",
      quoteAsset: "USD",
      settleAsset: "USDC",
      contractDirection: "quanto",
      contractMultiplier: 1,
      quantityUnit: "base",
      sizeDecimals: 5,
      quantityStep: 0.00001,
      minimumNotional: 10,
      tickSize: 0,
      priceRules: { staticTickSize: false, maxSignificantFigures: 5, maxDecimals: 1, integerPricesAlwaysAllowed: true },
      status: "trading",
      delistState: "active",
      delistStateVerified: true,
      referenceContext: {
        source: "hypercore-asset-context",
        executable: false,
        timestampSource: "local-receive",
        midPrice: 62821.5,
        markPrice: 62822,
        oraclePrice: 62833.8,
        currentFundingRate: 0.0000125
      }
    });
    expect(loom).toMatchObject({
      assetIndex: 1,
      status: "closed",
      delistState: "delisted",
      delistStateVerified: true,
      sizeDecimals: 1,
      quantityStep: 0.1,
      priceRules: { maxDecimals: 5 }
    });
  });

  it("keeps spot pair indexes, token IDs and native remapping identity separate", async () => {
    const snapshot = await adapter({ spotMetaAndAssetCtxs: SPOT_METADATA }, { network: "testnet" }).instruments("spot");
    const purr = snapshot.instruments.find((instrument) => instrument.apiCoin === "PURR/USDC");
    const ubtc = snapshot.instruments.find((instrument) => instrument.apiCoin === "@107");

    expect(snapshot.network).toBe("testnet");
    expect(purr).toMatchObject({
      id: "hyperliquid:testnet:spot:PURR/USDC",
      venueSymbol: "PURR/USDC",
      pairIndex: 0,
      assetIndex: 10000,
      baseAsset: "PURR",
      quoteAsset: "USDC",
      sizeDecimals: 0,
      quantityStep: 1,
      pairCanonical: true
    });
    expect(ubtc).toMatchObject({
      id: "hyperliquid:testnet:spot:@107",
      venueSymbol: "@107",
      pairIndex: 107,
      assetIndex: 10107,
      assetId: "hyperliquid:testnet:token:0x0123456789abcdef0123456789abcdef",
      baseAsset: "UBTC",
      quoteAsset: "USDC",
      sizeDecimals: 5,
      quantityStep: 0.00001,
      tickSize: 0,
      priceRules: { maxDecimals: 3 },
      delistState: "not-published-for-spot",
      delistStateVerified: false,
      pairCanonical: false,
      referenceContext: { markPrice: 62010, midPrice: 62020, executable: false }
    });
    expect(ubtc?.baseAsset).not.toBe("BTC");
    expect(ubtc?.baseToken).toMatchObject({ index: 150, nativeName: "UBTC", canonical: false });
  });

  it("builds an exact executable top book only from l2Book and rejects bulk fan-out", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = adapter(
      {
        "l2Book:BTC": BTC_BOOK
      },
      { onRequest: (url, init) => seen.push({ url, init }) }
    );

    const ticker = await client.ticker("BTC", "perpetual");

    expect(ticker).toMatchObject({
      source: "l2Book",
      executable: true,
      sequenceAvailable: false,
      bid: 62100,
      bidSize: 1.25,
      ask: 62101,
      askSize: 0.75,
      exchangeTs: 1_784_020_000_123
    });
    await expect(client.tickers("perpetual")).rejects.toMatchObject({ kind: "unsupported" });
    expect(seen).toHaveLength(1);
    for (const request of seen) {
      expect(new URL(request.url).pathname).toBe("/info");
      expect(request.init?.method).toBe("POST");
      expect(new Headers(request.init?.headers).has("Authorization")).toBe(false);
      expect(JSON.parse(String(request.init?.body)).type).toMatch(/^(metaAndAssetCtxs|l2Book)$/);
    }
  });

  it("returns bounded full-precision depth without inventing a sequence", async () => {
    const depth = await adapter({ "l2Book:BTC": BTC_BOOK }).depth({ instrumentId: "BTC", marketType: "perpetual", limit: 2 });

    expect(depth).toMatchObject({
      instrumentId: "BTC",
      marketType: "perpetual",
      quantityUnit: "base",
      source: "l2Book",
      complete: true,
      sequence: 0,
      sequenceVerified: false
    });
    expect(depth.bids).toEqual([
      [62100, 1.25, 4],
      [62099, 2.5, 7]
    ]);
    expect(depth.asks).toEqual([
      [62101, 0.75, 3],
      [62102, 1.5, 5]
    ]);
  });

  it("loads only caller-selected native spot books", async () => {
    const client = adapter({
      "l2Book:PURR/USDC": PURR_BOOK,
      "l2Book:@107": SPOT_107_BOOK
    });

    const [purr, ubtc] = await Promise.all([client.ticker("PURR/USDC", "spot"), client.ticker("@107", "spot")]);
    expect([purr.instrumentId, ubtc.instrumentId]).toEqual(["PURR/USDC", "@107"]);
    await expect(client.tickers("spot")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("normalizes verified one-hour HlPerp funding estimates and settled history", async () => {
    const requests: unknown[] = [];
    const funding = await adapter({ predictedFundings: PREDICTED_FUNDINGS, "fundingHistory:BTC": FUNDING_HISTORY }, { onRequest: (_url, init) => requests.push(JSON.parse(String(init?.body))) }).funding("BTC", { historyLimit: 2 });

    expect(funding).toMatchObject({
      venue: "hyperliquid",
      network: "mainnet",
      instrumentId: "BTC",
      currentEstimateRate: 0.0000125,
      currentEstimateSource: "predictedFundings:HlPerp",
      fundingTime: 1_784_023_200_000,
      nextFundingTime: 1_784_026_800_000,
      intervalMinutes: 60,
      scheduleVerified: true,
      minimumRate: -0.04,
      maximumRate: 0.04,
      timestampSource: "local-receive",
      exchangeTs: NOW,
      settledRate: 0.000013,
      sourceErrors: []
    });
    expect(funding.history).toEqual([expect.objectContaining({ fundingTime: 1_784_016_000_000, fundingRate: 0.000012, realizedRate: 0.000012, premium: -0.00017 }), expect.objectContaining({ fundingTime: 1_784_019_600_000, fundingRate: 0.000013, realizedRate: 0.000013, premium: -0.00016 })]);
    expect(requests).toEqual(expect.arrayContaining([{ type: "predictedFundings" }, expect.objectContaining({ type: "fundingHistory", coin: "BTC", endTime: NOW })]));
  });

  it("keeps the verified current estimate when only funding history fails", async () => {
    const funding = await adapter({
      predictedFundings: PREDICTED_FUNDINGS,
      "fundingHistory:BTC": { status: 503, body: {} }
    }).funding("BTC");

    expect(funding.currentEstimateRate).toBe(0.0000125);
    expect(funding.history).toEqual([]);
    expect(funding.sourceErrors[0]).toContain("HTTP 503");
  });

  it("fails closed for invalid books, unverified products and bulk-book requests", async () => {
    const crossed = {
      coin: "BTC",
      time: NOW,
      levels: [[{ px: "10", sz: "1", n: 1 }], [{ px: "9", sz: "1", n: 1 }]]
    };
    const client = adapter({ "l2Book:BTC": crossed });

    await expect(client.ticker("BTC", "perpetual")).rejects.toMatchObject({ kind: "validation" });
    await expect(client.depth({ instrumentId: "BTC", marketType: "perpetual", limit: 21 })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.instruments("future")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(client.funding("@107")).rejects.toMatchObject({ kind: "validation" });
    await expect(client.tickers("spot")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("classifies exchange errors, rate limits, timeouts, cancellation and payload bounds", async () => {
    await expect(adapter({ "l2Book:BTC": EXCHANGE_ERROR }).ticker("BTC", "perpetual")).rejects.toMatchObject({ kind: "exchange" });
    await expect(adapter({ "l2Book:BTC": { status: 429, body: {} } }).ticker("BTC", "perpetual")).rejects.toMatchObject({
      kind: "rate-limit",
      status: 429
    });

    const timeoutClient = new HyperliquidPublicAdapter({ fetch: abortingFetch(), timeoutMs: 5, now: () => NOW });
    await expect(timeoutClient.ticker("BTC", "perpetual")).rejects.toMatchObject({ kind: "timeout" });

    const cancellationClient = new HyperliquidPublicAdapter({ fetch: abortingFetch(), timeoutMs: 1_000, now: () => NOW });
    const controller = new AbortController();
    const pending = cancellationClient.ticker("BTC", "perpetual", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });

    const payloadClient = adapter({ metaAndAssetCtxs: PERP_METADATA }, { maxPayloadBytes: 16 });
    await expect(payloadClient.instruments("perpetual")).rejects.toMatchObject({ kind: "validation" });
  });
});

interface AdapterTestOptions {
  network?: "mainnet" | "testnet";
  maxPayloadBytes?: number;
  onRequest?: (url: string, init?: RequestInit) => void;
}

function adapter(routes: Record<string, unknown>, options: AdapterTestOptions = {}) {
  return new HyperliquidPublicAdapter({
    fetch: routedFetch(routes, options.onRequest),
    now: () => NOW,
    network: options.network,
    maxPayloadBytes: options.maxPayloadBytes,
    baseUrl: "https://fixture.hyperliquid.invalid"
  });
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/hyperliquid/${name}`, import.meta.url), "utf8"));
}

function routedFetch(routes: Record<string, unknown>, onRequest?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (input, init) => {
    onRequest?.(String(input), init);
    const body = JSON.parse(String(init?.body)) as { type?: string; coin?: string };
    const key = body.type === "l2Book" || body.type === "fundingHistory" ? `${body.type}:${body.coin}` : String(body.type);
    if (!(key in routes)) throw new Error(`Unexpected Hyperliquid fixture request: ${key}`);
    const configured = routes[key];
    if (isResponseConfig(configured)) return jsonResponse(configured.body, configured.status);
    return jsonResponse(configured);
  }) as typeof fetch;
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
