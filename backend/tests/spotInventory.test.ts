import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/trading/exchange/binance.js";
import { BybitAdapter } from "../src/trading/exchange/bybit.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("live spot inventory sizing", () => {
  it("sizes Binance spot closePct from the base asset balance", async () => {
    const orderUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v3/ticker/price")) return json({ price: "100" });
      if (url.includes("/api/v3/exchangeInfo")) {
        return json({
          symbols: [{
            symbol: "BTCUSDT",
            filters: [
              { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "MIN_NOTIONAL", minNotional: "1" }
            ]
          }]
        });
      }
      if (url.includes("/api/v3/account")) {
        return json({ balances: [{ asset: "BTC", free: "2", locked: "0" }, { asset: "USDT", free: "1000", locked: "0" }] });
      }
      if (url.includes("/api/v3/order")) {
        orderUrls.push(url);
        return json({ orderId: 1 });
      }
      return json({});
    });

    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "spot");
    const result = await adapter.execute({
      action: "neworder",
      market: "spot",
      symbol: "BTCUSDT",
      side: "sell",
      type: "market",
      closePct: 50,
      reduceOnly: true,
      reason: "test"
    });

    expect(result.ok).toBe(true);
    const orderUrl = new URL(orderUrls[0]);
    expect(orderUrl.searchParams.get("quantity")).toBe("1");
  });

  it("sizes Bybit spot closePct from the base asset balance", async () => {
    const orderBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json({
          retCode: 0,
          result: {
            list: [{
              symbol: "BTCUSDT",
              lotSizeFilter: { basePrecision: "0.001", minOrderQty: "0.001", minOrderAmt: "1" },
              priceFilter: { tickSize: "0.01" }
            }]
          }
        });
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return json({
          retCode: 0,
          retMsg: "OK",
          result: {
            list: [{
              totalEquity: "1000",
              totalAvailableBalance: "1000",
              coin: [{ coin: "BTC", walletBalance: "2", availableToWithdraw: "2" }]
            }]
          }
        });
      }
      if (url.includes("/v5/order/create")) {
        orderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ retCode: 0, retMsg: "OK", result: { orderId: "1" } });
      }
      return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
    });

    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "spot");
    const result = await adapter.execute({
      action: "neworder",
      market: "spot",
      symbol: "BTCUSDT",
      side: "sell",
      type: "market",
      closePct: 50,
      reduceOnly: true,
      reason: "test"
    });

    expect(result.ok).toBe(true);
    expect(orderBodies[0]).toMatchObject({ category: "spot", symbol: "BTCUSDT", side: "Sell", qty: "1" });
  });
});

function json(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
}
