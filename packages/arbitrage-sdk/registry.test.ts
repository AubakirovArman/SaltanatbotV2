import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient, parseInstrumentRegistry, parseVenueCapabilities } from "./index.js";

describe("public registry SDK contract", () => {
  it("sends every bounded instrument query and preserves exact freshness envelopes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/instruments") {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          venue: "deribit",
          marketType: "option",
          symbol: "BTC-30JUL26-100000-C",
          assetId: "BTC",
          status: "trading",
          includeStale: "true",
          limit: "25"
        });
        return json(instrumentEnvelope());
      }
      expect(url.pathname).toBe("/api/venues");
      expect(url.search).toBe("");
      return json(venueEnvelope());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });

    await expect(
      client.instruments({
        venue: "deribit",
        marketType: "option",
        symbol: "BTC-30JUL26-100000-C",
        assetId: "BTC",
        status: "trading",
        includeStale: true,
        limit: 25
      })
    ).resolves.toMatchObject({
      updatedAt: 10_000,
      checkedAt: 10_000,
      stale: true,
      includeStale: true,
      total: 2,
      truncated: true,
      instruments: [{ economicAssetId: "crypto:bitcoin" }],
      sourceErrors: ["OKX swap: temporary outage"],
      sourceStates: [{ status: "fresh" }, { status: "stale-cache", ageMs: 200 }]
    });
    await expect(client.venues()).resolves.toMatchObject({
      checkedAt: 10_000,
      stale: false,
      capabilities: [{ venue: "deribit", option: true }],
      sourceErrors: [],
      sourceStates: [{ source: "deribit:public", status: "fresh" }]
    });
  });

  it("rejects unsafe or inconsistent envelope and source timestamps", () => {
    const invalid = [
      { updatedAt: 0 },
      { updatedAt: 10_000.5 },
      { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      { checkedAt: 9_999 },
      { sourceStates: [{ ...freshState(), checkedAt: 9_999 }] },
      { sourceStates: [{ ...freshState(), receivedAt: 10_001 }] },
      { sourceStates: [{ ...freshState(), receivedAt: 9_999 }] },
      { sourceStates: [{ ...freshState(), receivedAt: 9_999, ageMs: 2 }] },
      { sourceStates: [{ ...freshState(), ageMs: 0.5 }] }
    ];
    for (const change of invalid) expect(() => parseInstrumentRegistry({ ...healthyInstrumentEnvelope(), ...change })).toThrow();
  });

  it("accepts an early concurrent source as fresh when its age is coherent", () => {
    const parsed = parseInstrumentRegistry({
      ...healthyInstrumentEnvelope(),
      updatedAt: 30_100,
      checkedAt: 30_100,
      sourceStates: [{ ...freshState(), receivedAt: 30_000, checkedAt: 30_100, ageMs: 100 }]
    });

    expect(parsed.sourceStates[0]).toMatchObject({ status: "fresh", receivedAt: 30_000, checkedAt: 30_100, ageMs: 100 });
  });

  it("enforces unique sources and status-specific age/receipt/message invariants", () => {
    const base = healthyInstrumentEnvelope();
    const invalidStates = [
      [freshState(), { ...freshState() }],
      [{ source: "binance:spot", status: "fresh", checkedAt: 10_000, ageMs: 0 }],
      [{ ...freshState(), message: "unexpected" }],
      [{ source: "okx:swap", status: "stale-cache", receivedAt: 9_800, checkedAt: 10_000, ageMs: 200 }],
      [{ source: "okx:swap", status: "stale-cache", receivedAt: 9_800, checkedAt: 10_000, ageMs: 199, message: "outage" }],
      [{ source: "okx:swap", status: "quarantined", checkedAt: 10_000 }],
      [{ source: "okx:swap", status: "quarantined", receivedAt: 9_800, checkedAt: 10_000, message: "expired" }],
      [{ source: "okx:swap", status: "quarantined", receivedAt: 9_800, checkedAt: 10_000, ageMs: 201, message: "expired" }]
    ];
    for (const sourceStates of invalidStates) {
      expect(() => parseInstrumentRegistry({ ...base, stale: true, sourceErrors: ["source failure"], sourceStates })).toThrow();
    }

    expect(
      parseInstrumentRegistry({
        ...base,
        stale: true,
        sourceErrors: ["OKX swap: no cache"],
        sourceStates: [{ source: "okx:swap", status: "quarantined", checkedAt: 10_000, message: "no cache" }]
      }).sourceStates[0]
    ).toEqual({ source: "okx:swap", status: "quarantined", checkedAt: 10_000, message: "no cache" });
  });

  it("derives stale and pagination consistency instead of trusting flags", () => {
    const healthy = healthyInstrumentEnvelope();
    expect(() => parseInstrumentRegistry({ ...healthy, stale: true })).toThrow(/stale flag/);
    expect(() => parseInstrumentRegistry({ ...healthy, stale: false, sourceErrors: ["malformed rows"] })).toThrow(/stale flag/);
    expect(() => parseInstrumentRegistry({ ...healthy, includeStale: undefined })).toThrow(/includeStale/);
    expect(() => parseInstrumentRegistry({ ...healthy, includeStale: "false" })).toThrow(/includeStale/);
    expect(() => parseInstrumentRegistry({ ...healthy, total: 0 })).toThrow(/total/);
    expect(() => parseInstrumentRegistry({ ...healthy, total: 2, truncated: false })).toThrow(/truncated/);
    expect(() => parseInstrumentRegistry({ ...healthy, total: 1, truncated: true })).toThrow(/truncated/);
    expect(() => parseInstrumentRegistry({ ...healthy, total: 2, truncated: false, instruments: [instrument(), instrument()] })).toThrow(/IDs must be unique/);
  });

  it("applies the same freshness contract to venue capabilities", () => {
    const valid = venueEnvelope();
    expect(parseVenueCapabilities(valid)).toMatchObject({ updatedAt: 10_000, checkedAt: 10_000, stale: false });
    expect(() => parseVenueCapabilities({ ...valid, checkedAt: 9_999 })).toThrow(/must match/);
    expect(() => parseVenueCapabilities({ ...valid, stale: true })).toThrow(/stale flag/);
    expect(() => parseVenueCapabilities({ ...valid, sourceStates: [freshState(), freshState()] })).toThrow(/source names must be unique/);
    expect(() => parseVenueCapabilities({ ...valid, capabilities: [capability("deribit"), capability("deribit")] })).toThrow(/must be unique/);
  });

  it("requires product-scoped evidence for private account capabilities", () => {
    const valid = venueEnvelope();
    const scoped = {
      ...capability("bybit"),
      scopes: [
        { product: "spot", operation: "public-data", status: "implemented" },
        { product: "perpetual", operation: "private-execution", status: "experimental" },
        { product: "account", operation: "borrow", status: "manual-only" }
      ]
    };
    expect(parseVenueCapabilities({ ...valid, capabilities: [scoped] }).capabilities[0]?.scopes).toEqual(scoped.scopes);
    expect(() => parseVenueCapabilities({ ...valid, capabilities: [{ ...capability("binance"), privateExecution: true }] })).toThrow(/privateExecution/);
    expect(() => parseVenueCapabilities({
      ...valid,
      capabilities: [{
        ...scoped,
        scopes: [
          { product: "spot", operation: "public-data", status: "implemented" },
          { product: "spot", operation: "public-data", status: "experimental" }
        ]
      }]
    })).toThrow(/product\/operation scopes must be unique/);
  });
});

function healthyInstrumentEnvelope() {
  return {
    updatedAt: 10_000,
    checkedAt: 10_000,
    stale: false,
    includeStale: false,
    total: 1,
    truncated: false,
    instruments: [instrument()],
    sourceErrors: [],
    sourceStates: [freshState()]
  };
}

function instrumentEnvelope() {
  return {
    ...healthyInstrumentEnvelope(),
    stale: true,
    includeStale: true,
    total: 2,
    truncated: true,
    sourceErrors: ["OKX swap: temporary outage"],
    sourceStates: [freshState(), { source: "okx:swap", status: "stale-cache", receivedAt: 9_800, checkedAt: 10_000, ageMs: 200, message: "temporary outage" }]
  };
}

function venueEnvelope() {
  return {
    updatedAt: 10_000,
    checkedAt: 10_000,
    stale: false,
    capabilities: [capability("deribit")],
    sourceErrors: [],
    sourceStates: [{ ...freshState(), source: "deribit:public" }]
  };
}

function freshState() {
  return { source: "binance:spot", status: "fresh", receivedAt: 10_000, checkedAt: 10_000, ageMs: 0 };
}

function instrument() {
  return {
    id: "deribit:option:BTC-30JUL26-100000-C",
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue: "deribit",
    venueSymbol: "BTC-30JUL26-100000-C",
    baseAsset: "BTC",
    quoteAsset: "USD",
    settleAsset: "BTC",
    marketType: "option",
    contractDirection: "inverse",
    contractMultiplier: 1,
    contractValue: 1,
    contractValueCurrency: "USD",
    quantityUnit: "contract",
    underlying: "BTC-30JUL26",
    instrumentFamily: "BTC",
    tickSize: 0.0001,
    quantityStep: 0.1,
    minimumQuantity: 0.1,
    minimumNotional: 0,
    status: "trading",
    expiryTime: 20_000,
    strikePrice: 100_000,
    optionType: "call"
  };
}

function capability(venue: string) {
  return {
    venue,
    publicData: true,
    spot: false,
    margin: false,
    perpetual: true,
    datedFuture: true,
    option: true,
    nativeSpread: false,
    topBook: true,
    depth: true,
    publicTrades: false,
    funding: true,
    borrow: false,
    depositWithdrawal: false,
    privateExecution: false,
    demoEnvironment: true
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
