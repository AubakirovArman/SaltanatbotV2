import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceFilters, bybitFilters, checkMinimums, clearFilterCache, FILTER_TTL_MS, floorPercentToIncrement, floorToIncrement, roundToStep, roundToTick, type SymbolFilters } from "../src/trading/exchange/filters.js";

afterEach(() => {
  clearFilterCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("exact instrument-rule arithmetic", () => {
  it("floors quantity and price without IEEE-754 boundary drift", () => {
    expect(floorToIncrement(0.1 + 0.2, "0.01")).toBe("0.3");
    expect(floorToIncrement("0.000000019", "0.00000001")).toBe("0.00000001");
    expect(floorToIncrement("61862.037", "0.01")).toBe("61862.03");
    expect(floorPercentToIncrement("0.123", "50", "0.001")).toBe("0.061");
  });

  it("keeps compatibility number helpers deterministic", () => {
    expect(roundToStep(1.23456, "0.001")).toBe(1.234);
    expect(roundToStep(3.9, "1")).toBe(3);
    expect(roundToStep(0.007, "0.005")).toBe(0.005);
    expect(roundToTick(61862.037, "0.01")).toBe(61862.03);
    expect(roundToStep(1.23456, undefined)).toBe(1.23456);
    expect(roundToStep(NaN, "0.1")).toBeNaN();
  });

  it("checks exact min/max quantity, price and notional bounds", () => {
    const rules = filters();
    expect(checkMinimums("0.01", "1000", rules)).toBeUndefined();
    expect(checkMinimums("0.0005", "1000", rules)).toMatch(/minQty/);
    expect(checkMinimums("0.001", "1000", rules)).toMatch(/minNotional/);
    expect(checkMinimums("101", "1000", rules)).toMatch(/maxQty/);
    expect(checkMinimums("0.01", "0.001", rules)).toMatch(/minPrice/);
    expect(checkMinimums("0.01", "1000001", rules)).toMatch(/maxPrice/);
    expect(checkMinimums("2", "1000", { ...rules, maxNotional: "1000", maxNotionalAppliesToMarket: true })).toMatch(/maxNotional/);
  });

  it("fails closed when verified rules are absent", () => {
    expect(checkMinimums("0.01", "1000", undefined)).toMatch(/unavailable/);
  });
});

describe("verified instrument-rule loaders", () => {
  it("never falls back to the first Binance row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(binanceInfo("ETHUSDT")))
    );
    await expect(binanceFilters("BTCUSDT", "futures")).rejects.toThrow(/0 exact rows/);
  });

  it("rejects partial Binance and Bybit rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("binance")) {
          const payload = binanceInfo("BTCUSDT");
          payload.symbols[0]!.filters = payload.symbols[0]!.filters.filter((rule) => rule.filterType !== "PRICE_FILTER");
          return json(payload);
        }
        const payload = bybitInfo("BTCUSDT");
        (payload.result.list[0]!.lotSizeFilter as { maxMktOrderQty?: string }).maxMktOrderQty = undefined;
        return json(payload);
      })
    );
    await expect(binanceFilters("BTCUSDT", "futures")).rejects.toThrow(/PRICE_FILTER/);
    await expect(bybitFilters("BTCUSDT", "futures")).rejects.toThrow(/market maxOrderQty/);
  });

  it("uses a stable fingerprint but never serves rules beyond their TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00Z"));
    const fetcher = vi.fn(async () => json(binanceInfo("BTCUSDT")));
    vi.stubGlobal("fetch", fetcher);

    const first = await binanceFilters("BTCUSDT", "futures");
    const cached = await binanceFilters("BTCUSDT", "futures");
    expect(cached).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FILTER_TTL_MS + 1);
    const refreshed = await binanceFilters("BTCUSDT", "futures");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.verifiedAt).toBeGreaterThan(first.verifiedAt);
    expect(refreshed.fingerprint).toBe(first.fingerprint);
  });

  it("uses current Bybit spot amount and distinct market/limit quantity fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          retCode: 0,
          result: {
            list: [
              {
                symbol: "BTCUSDT",
                status: "Trading",
                lotSizeFilter: {
                  basePrecision: "0.0001",
                  minOrderAmt: "5",
                  maxLimitOrderQty: "2",
                  maxMarketOrderQty: "1",
                  minOrderQty: "10",
                  maxOrderQty: "999",
                  maxOrderAmt: "1"
                },
                priceFilter: { tickSize: "0.01" }
              }
            ]
          }
        })
      )
    );

    const rules = await bybitFilters("BTCUSDT", "spot");
    expect(rules).toMatchObject({
      stepSize: "0.0001",
      marketStepSize: "0.0001",
      minQty: "0.0001",
      marketMinQty: "0.0001",
      maxQty: "2",
      marketMaxQty: "1",
      minNotional: "5"
    });
    expect(rules.maxNotional).toBeUndefined();
  });

  it("rejects deprecated-only Bybit spot caps instead of guessing order semantics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          retCode: 0,
          result: {
            list: [
              {
                symbol: "BTCUSDT",
                status: "Trading",
                lotSizeFilter: { basePrecision: "0.001", minOrderAmt: "5", maxOrderQty: "100" },
                priceFilter: { tickSize: "0.01" }
              }
            ]
          }
        })
      )
    );

    await expect(bybitFilters("BTCUSDT", "spot")).rejects.toThrow(/maxOrderQty/);
  });
});

function filters(): SymbolFilters {
  return {
    exchange: "binance",
    market: "futures",
    symbol: "BTCUSDT",
    status: "trading",
    stepSize: "0.001",
    marketStepSize: "0.001",
    tickSize: "0.01",
    minQty: "0.001",
    marketMinQty: "0.001",
    maxQty: "100",
    marketMaxQty: "50",
    minNotional: "5",
    minNotionalAppliesToMarket: true,
    minPrice: "0.01",
    maxPrice: "1000000",
    fingerprint: "pure-helper-fixture",
    verifiedAt: 1,
    expiresAt: 2
  };
}

function binanceInfo(symbol: string) {
  return {
    symbols: [
      {
        symbol,
        status: "TRADING",
        filters: [
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "100" },
          { filterType: "MARKET_LOT_SIZE", stepSize: "0.002", minQty: "0.002", maxQty: "50" },
          { filterType: "PRICE_FILTER", tickSize: "0.1", minPrice: "0.1", maxPrice: "1000000" },
          { filterType: "MIN_NOTIONAL", notional: "5" }
        ]
      }
    ]
  };
}

function bybitInfo(symbol: string) {
  return {
    retCode: 0,
    result: {
      list: [
        {
          symbol,
          status: "Trading",
          lotSizeFilter: {
            qtyStep: "0.001",
            minOrderQty: "0.001",
            maxOrderQty: "100",
            maxMktOrderQty: "50",
            minNotionalValue: "5"
          },
          priceFilter: { tickSize: "0.1", minPrice: "0.1", maxPrice: "1000000" }
        }
      ]
    }
  };
}

function json(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
}
