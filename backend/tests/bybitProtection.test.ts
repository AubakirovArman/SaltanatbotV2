import { afterEach, describe, expect, it, vi } from "vitest";
import { BybitAdapter } from "../src/trading/exchange/bybit.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";

type FetchCall = { url: string; method: string; body?: Record<string, unknown> };

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("Bybit futures protection", () => {
  it("submits exchange-side SL/TP through trading-stop after an entry", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });

      if (url.includes("/v5/market/tickers")) {
        return json({ result: { list: [{ lastPrice: "100" }] } });
      }
      if (url.includes("/v5/market/instruments-info")) {
        return json({
          retCode: 0,
          result: {
            list: [
              {
                symbol: "BTCUSDT",
                lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "5" },
                priceFilter: { tickSize: "0.1" }
              }
            ]
          }
        });
      }
      if (url.includes("/v5/position/list")) {
        return json({ retCode: 0, retMsg: "OK", result: { list: [{ side: "Buy", size: "1", avgPrice: "100", leverage: "1" }] } });
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return json({ retCode: 0, retMsg: "OK", result: { list: [{ totalEquity: "1000", totalAvailableBalance: "1000" }] } });
      }
      return json({ retCode: 0, retMsg: "OK", result: { orderId: "ok" } });
    });

    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");
    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      stop: { basis: "price", value: 95 },
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 100 }],
      reason: "test"
    });

    expect(result.ok).toBe(true);
    const protection = calls.find((call) => call.url.includes("/v5/position/trading-stop"));
    expect(protection?.method).toBe("POST");
    expect(protection?.body).toMatchObject({
      category: "linear",
      symbol: "BTCUSDT",
      tpslMode: "Full",
      positionIdx: 0,
      stopLoss: "95",
      takeProfit: "110",
      slTriggerBy: "LastPrice",
      tpTriggerBy: "LastPrice"
    });
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
