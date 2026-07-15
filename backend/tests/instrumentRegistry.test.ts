import { describe, expect, it } from "vitest";
import { InstrumentRegistry } from "../src/market/instrumentRegistry.js";
import { BASIS_ECONOMIC_ASSET_IDS, ECONOMIC_ASSET_IDENTITY_CATALOG, reviewedBasisEconomicAssetId, reviewedEconomicAssetIdentity, withReviewedEconomicAssetIdentity } from "../src/market/economicAssetIdentity.js";
import { ArbitrageDepthService } from "../src/arbitrage/depth.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";

describe("instrument registry", () => {
  it("uses only exact reviewed basis identities and fails closed for unknown tuples", () => {
    const btc = {
      venue: "binance",
      marketType: "spot" as const,
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      settleAsset: "USDT"
    };
    const eth = { ...btc, venue: "bybit", marketType: "perpetual" as const, symbol: "ETHUSDT", baseAsset: "ETH" };

    expect(reviewedBasisEconomicAssetId(btc)).toBe(BASIS_ECONOMIC_ASSET_IDS.bitcoin);
    expect(reviewedBasisEconomicAssetId(eth)).toBe(BASIS_ECONOMIC_ASSET_IDS.ethereum);
    expect(reviewedBasisEconomicAssetId({ ...btc, symbol: "CATUSDT", baseAsset: "CAT" })).toBeUndefined();
    expect(reviewedBasisEconomicAssetId({ ...btc, quoteAsset: "USDC" })).toBeUndefined();
    expect(reviewedBasisEconomicAssetId({ ...btc, marketType: "future" })).toBeUndefined();

    expect(
      reviewedEconomicAssetIdentity({
        id: "kucoin:perpetual:XBTUSDTM",
        venue: "kucoin",
        marketType: "perpetual",
        venueSymbol: "XBTUSDTM",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        settleAsset: "USDT"
      })
    ).toMatchObject({
      economicAssetId: "crypto:bitcoin",
      evidence: { status: "reviewed", version: ECONOMIC_ASSET_IDENTITY_CATALOG.version }
    });
    expect(
      reviewedEconomicAssetIdentity({
        id: "kucoin:perpetual:XBTUSDTM",
        venue: "kucoin",
        marketType: "perpetual",
        venueSymbol: "XBTUSDTM",
        baseAsset: "WBTC",
        quoteAsset: "USDT",
        settleAsset: "USDT"
      })
    ).toBeUndefined();
    expect(withReviewedEconomicAssetIdentity({ ...registryInstrument("unknown", "spot", "BTCUSDT", 0.001), economicAssetId: "crypto:bitcoin" })).not.toHaveProperty("economicAssetId");
  });

  it("normalizes venue filters, funding schedules and contract metadata", async () => {
    let calls = 0;
    const registry = new InstrumentRegistry({
      now: () => 10_000,
      fetch: async (input) => {
        calls += 1;
        const url = String(input);
        if (url.includes("api/v3/exchangeInfo")) {
          return json({ symbols: [binanceSymbol("BTCUSDT", "BTC", "spot")] });
        }
        if (url.includes("fapi/v1/exchangeInfo")) {
          return json({
            symbols: [binanceSymbol("BTCUSDT", "BTC", "PERPETUAL"), { ...binanceSymbol("ETHUSDT_260925", "ETH", "CURRENT_QUARTER"), deliveryDate: 2_000_000 }]
          });
        }
        if (url.includes("fundingInfo")) return json([{ symbol: "BTCUSDT", fundingIntervalHours: 4 }]);
        if (url.includes("category=spot")) return json(bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "spot")]));
        if (url.includes("category=linear")) return json(bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "perpetual")]));
        if (url.includes("/api/v5/public/instruments")) return json(okxInstruments(url));
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const snapshot = await registry.snapshot();
    const binancePerpetual = snapshot.instruments.find((row) => row.id === "binance:perpetual:BTCUSDT");
    const bybitPerpetual = snapshot.instruments.find((row) => row.id === "bybit:perpetual:BTCUSDT");
    const datedFuture = snapshot.instruments.find((row) => row.marketType === "future");

    expect(snapshot.sourceErrors).toEqual([]);
    expect(binancePerpetual).toMatchObject({
      assetId: "BTC",
      economicAssetId: "crypto:bitcoin",
      tickSize: 0.1,
      quantityStep: 0.001,
      minimumNotional: 5,
      fundingIntervalMinutes: 240
    });
    expect(bybitPerpetual).toMatchObject({ economicAssetId: "crypto:bitcoin", fundingIntervalMinutes: 60, settleAsset: "USDT" });
    expect(datedFuture).toMatchObject({ venueSymbol: "ETHUSDT_260925", expiryTime: 2_000_000 });
    expect(datedFuture).not.toHaveProperty("economicAssetId");
    expect(snapshot.capabilities.find((row) => row.venue === "binance")).toMatchObject({
      margin: false,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false,
      scopes: expect.arrayContaining([
        { product: "spot", operation: "public-data", status: "implemented" },
        { product: "perpetual", operation: "private-execution", status: "experimental" }
      ])
    });
    expect(snapshot.capabilities.find((row) => row.venue === "bybit")).toMatchObject({
      nativeSpread: true,
      option: false,
      margin: false,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false,
      scopes: expect.arrayContaining([
        { product: "native-spread", operation: "public-data", status: "implemented" },
        { product: "account", operation: "borrow", status: "manual-only" }
      ])
    });
    expect(snapshot.capabilities.find((row) => row.venue === "okx")).toMatchObject({
      spot: true,
      perpetual: true,
      datedFuture: true,
      depth: true,
      funding: true,
      privateExecution: false
    });
    expect(snapshot.instruments.find((row) => row.id === "okx:perpetual:BTC-USDT-SWAP")).toMatchObject({
      economicAssetId: "crypto:bitcoin",
      contractDirection: "linear",
      contractValue: 0.01,
      contractValueCurrency: "BTC",
      quantityUnit: "contract"
    });

    await registry.snapshot();
    expect(calls).toBe(8);
  });

  it("retains each source's last successful instruments during a partial refresh failure", async () => {
    let now = 20_000;
    let failOkxSwap = false;
    const registry = new InstrumentRegistry({
      now: () => now,
      cacheTtlMs: 1_000,
      maxStaleMs: 100,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api/v3/exchangeInfo")) return json({ symbols: [binanceSymbol("BTCUSDT", "BTC", "spot")] });
        if (url.includes("fapi/v1/exchangeInfo")) return json({ symbols: [binanceSymbol("BTCUSDT", "BTC", "PERPETUAL")] });
        if (url.includes("fundingInfo")) return json([{ symbol: "BTCUSDT", fundingIntervalHours: 4 }]);
        if (url.includes("category=spot")) return json(bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "spot")]));
        if (url.includes("category=linear")) return json(bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "perpetual")]));
        if (url.includes("/api/v5/public/instruments")) {
          if (failOkxSwap && url.includes("instType=SWAP")) throw new Error("temporary OKX outage");
          return json(okxInstruments(url));
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const initial = await registry.snapshot();
    expect(initial.instruments.some((row) => row.id === "okx:perpetual:BTC-USDT-SWAP")).toBe(true);

    failOkxSwap = true;
    now = 20_050;
    const refreshed = await registry.snapshot(true);

    expect(refreshed.instruments.some((row) => row.id === "okx:perpetual:BTC-USDT-SWAP")).toBe(true);
    expect(refreshed.verifiedInstruments.some((row) => row.id === "okx:perpetual:BTC-USDT-SWAP")).toBe(false);
    expect(refreshed.sourceStates).toContainEqual(expect.objectContaining({ source: "okx:swap", status: "stale-cache", receivedAt: 20_000, checkedAt: 20_050, ageMs: 50 }));
    expect(refreshed.sourceErrors.some((error) => error.includes("OKX swap") && error.includes("temporary OKX outage"))).toBe(true);
    await expect(registry.get("okx", "perpetual", "BTC-USDT-SWAP")).resolves.toBeUndefined();

    now = 20_101;
    const quarantined = await registry.snapshot(true);
    expect(quarantined.instruments.some((row) => row.id === "okx:perpetual:BTC-USDT-SWAP")).toBe(false);
    expect(quarantined.sourceStates).toContainEqual(expect.objectContaining({ source: "okx:swap", status: "quarantined", receivedAt: 20_000, checkedAt: 20_101, ageMs: 101 }));
  });

  it("merges explicitly injected extended public adapter metadata with source freshness", async () => {
    const now = 15_000;
    const gate = {
      venue: "gate",
      capabilities: () => ({
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
      }),
      instruments: async (marketType) => {
        if (marketType !== "spot" && marketType !== "perpetual") throw new Error("unsupported fixture market");
        return {
          venue: "gate",
          marketType,
          receivedAt: now - 5,
          instruments: [{ ...publicInstrument("gate", marketType, "BTC_USDT"), economicAssetId: "crypto:unreviewed-adapter-assertion" }],
          rejectedRows: []
        };
      }
    } satisfies Pick<PublicVenueAdapter, "venue" | "capabilities" | "instruments">;
    const registry = new InstrumentRegistry({
      now: () => now,
      fetch: async (input) => json(registryPayload(String(input))),
      extendedPublicAdapters: new Map([["gate", gate]])
    });

    const snapshot = await registry.snapshot();

    expect(snapshot.verifiedInstruments).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gate:spot:BTC_USDT", marketType: "spot", economicAssetId: "crypto:bitcoin" }), expect.objectContaining({ id: "gate:perpetual:BTC_USDT", marketType: "perpetual", economicAssetId: "crypto:bitcoin" })]));
    expect(snapshot.sourceStates).toEqual(expect.arrayContaining([expect.objectContaining({ source: "gate:spot", status: "fresh", receivedAt: now - 5, ageMs: 5 }), expect.objectContaining({ source: "gate:perpetual", status: "fresh", receivedAt: now - 5, ageMs: 5 })]));
  });

  it("preserves each source receipt time and expires the snapshot from the earliest source", async () => {
    let now = 30_000;
    let calls = 0;
    let deferResponses = true;
    const pending = new Map<string, (response: Response) => void>();
    const registry = new InstrumentRegistry({
      now: () => now,
      cacheTtlMs: 100,
      fetch: ((input: RequestInfo | URL) => {
        calls += 1;
        const url = String(input);
        if (!deferResponses) return Promise.resolve(json(registryPayload(url)));
        return new Promise<Response>((resolve) => pending.set(url, resolve));
      }) as typeof fetch
    });

    const snapshotPromise = registry.snapshot();
    await waitForPending(pending, 8);
    const earlyUrl = [...pending.keys()].find((url) => url.includes("api/v3/exchangeInfo"));
    expect(earlyUrl).toBeDefined();
    pending.get(earlyUrl!)!(json(registryPayload(earlyUrl!)));
    pending.delete(earlyUrl!);
    await settleEventLoop();

    now = 30_100;
    for (const [url, resolve] of pending) resolve(json(registryPayload(url)));
    const snapshot = await snapshotPromise;

    expect(snapshot.sourceStates).toContainEqual({ source: "binance:spot", status: "fresh", receivedAt: 30_000, checkedAt: 30_100, ageMs: 100 });
    expect(snapshot.sourceStates).toContainEqual({ source: "bybit:spot", status: "fresh", receivedAt: 30_100, checkedAt: 30_100, ageMs: 0 });

    deferResponses = false;
    now = 30_101;
    await registry.snapshot();
    expect(calls).toBe(16);
  });

  it("supplies verified lot steps to two-leg depth matching", async () => {
    const service = new ArbitrageDepthService({
      now: () => 1_000,
      registry: {
        get: async (venue, marketType, symbol) => registryInstrument(venue, marketType, symbol, marketType === "spot" ? 0.01 : 0.1)
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api/v3/depth")) return json({ asks: [["100", "2"]], bids: [["99", "2"]] });
        if (url.includes("category=linear")) return json({ retCode: 0, result: { b: [["103", "2"]], a: [["104", "2"]] } });
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const depth = await service.analyze({ symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", notionalUsd: 105 });

    expect(depth.precisionVerified).toBe(true);
    expect(depth.quantityStepSource).toBe("instrument");
    expect(depth.quantityStep).toBe(0.1);
    expect(depth.matchedQuantity).toBe(1);
    expect(depth.residualDeltaQuantity).toBe(0);
  });
});

function binanceSymbol(symbol: string, baseAsset: string, kind: "spot" | "PERPETUAL" | "CURRENT_QUARTER") {
  return {
    symbol,
    status: "TRADING",
    contractType: kind === "spot" ? undefined : kind,
    baseAsset,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    isSpotTradingAllowed: true,
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
      { filterType: "MIN_NOTIONAL", notional: "5" }
    ]
  };
}

function bybitInstrument(symbol: string, baseCoin: string, kind: "spot" | "perpetual") {
  return {
    symbol,
    contractType: kind === "perpetual" ? "LinearPerpetual" : undefined,
    status: "Trading",
    baseCoin,
    quoteCoin: "USDT",
    settleCoin: "USDT",
    fundingInterval: kind === "perpetual" ? 60 : undefined,
    priceFilter: { tickSize: "0.1" },
    lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "5" }
  };
}

function bybitEnvelope(list: unknown[]) {
  return { retCode: 0, retMsg: "OK", result: { list, nextPageCursor: "" } };
}

function okxInstruments(url: string) {
  const instrumentType = new URL(url).searchParams.get("instType");
  if (instrumentType === "SPOT") {
    return {
      code: "0",
      msg: "",
      data: [{ instType: "SPOT", instId: "BTC-USDT", baseCcy: "BTC", quoteCcy: "USDT", tickSz: "0.1", lotSz: "0.00001", minSz: "0.00001", state: "live" }]
    };
  }
  const future = instrumentType === "FUTURES";
  return {
    code: "0",
    msg: "",
    data: [
      {
        instType: future ? "FUTURES" : "SWAP",
        instId: future ? "BTC-USDT-260925" : "BTC-USDT-SWAP",
        instFamily: "BTC-USDT",
        uly: "BTC-USDT",
        settleCcy: "USDT",
        ctVal: "0.01",
        ctMult: "1",
        ctValCcy: "BTC",
        ctType: "linear",
        tickSz: "0.1",
        lotSz: "1",
        minSz: "1",
        expTime: future ? "1790294400000" : "",
        state: "live"
      }
    ]
  };
}

function registryPayload(url: string) {
  if (url.includes("api/v3/exchangeInfo")) return { symbols: [binanceSymbol("BTCUSDT", "BTC", "spot")] };
  if (url.includes("fapi/v1/exchangeInfo")) return { symbols: [binanceSymbol("BTCUSDT", "BTC", "PERPETUAL")] };
  if (url.includes("fundingInfo")) return [{ symbol: "BTCUSDT", fundingIntervalHours: 4 }];
  if (url.includes("category=spot")) return bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "spot")]);
  if (url.includes("category=linear")) return bybitEnvelope([bybitInstrument("BTCUSDT", "BTC", "perpetual")]);
  if (url.includes("/api/v5/public/instruments")) return okxInstruments(url);
  throw new Error(`Unexpected URL: ${url}`);
}

async function waitForPending(pending: Map<string, unknown>, expected: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pending.size === expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expected} pending registry requests, received ${pending.size}`);
}

async function settleEventLoop() {
  for (let step = 0; step < 3; step += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function registryInstrument(venue: string, marketType: "spot" | "perpetual", symbol: string, quantityStep: number): NonNullable<Awaited<ReturnType<InstrumentRegistry["get"]>>> {
  return {
    id: `${venue}:${marketType}:${symbol}`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol: symbol,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.1,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional: 5,
    status: "trading"
  };
}

function publicInstrument(venue: string, marketType: "spot" | "perpetual", symbol: string) {
  return {
    id: `${venue}:${marketType}:${symbol}`,
    assetId: "BTC",
    venue,
    venueSymbol: symbol,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base" as const,
    tickSize: 0.1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading" as const
  };
}
