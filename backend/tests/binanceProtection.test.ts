import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/trading/exchange/binance.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("Binance futures protection", () => {
  it("confirms protection only after every requested SL/TP order succeeds", async () => {
    const orderTypes: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes));

    const result = await executeProtectedEntry();

    expect(result.ok).toBe(true);
    expect(result.protection).toEqual({ requested: true, confirmed: true });
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);
  });

  it("fails and closes the entry when take-profit placement is rejected", async () => {
    const orderTypes: string[] = [];
    const cancelledOrderIds: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { rejectTakeProfit: true, cancelledOrderIds }));

    const result = await executeProtectedEntry();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/take-profit rejected/i);
    expect(result.protection).toMatchObject({ requested: true, confirmed: false });
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET", "MARKET"]);
    expect(cancelledOrderIds).toEqual(["2"]);
  });
});

function executeProtectedEntry() {
  const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");
  return adapter.execute({
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
}

function binanceFetch(orderTypes: string[], options: { rejectTakeProfit?: boolean; cancelledOrderIds?: string[] } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
    if (url.pathname.endsWith("/exchangeInfo")) {
      return json({
        symbols: [{
          symbol: "BTCUSDT",
          filters: [
            { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
            { filterType: "PRICE_FILTER", tickSize: "0.1" },
            { filterType: "MIN_NOTIONAL", notional: "5" }
          ]
        }]
      });
    }
    if (url.pathname.endsWith("/positionRisk")) return json([]);
    if (url.pathname.endsWith("/balance")) return json([{ asset: "USDT", balance: "1000" }]);
    if (url.pathname.endsWith("/account")) return json({ totalWalletBalance: "1000", totalUnrealizedProfit: "0" });
    if (url.pathname.endsWith("/openOrders")) return json([]);
    if (url.pathname.endsWith("/leverage")) return json({ leverage: 1 });
    if (url.pathname.endsWith("/order") && init?.method === "DELETE") {
      options.cancelledOrderIds?.push(url.searchParams.get("orderId") ?? "");
      return json({});
    }
    if (url.pathname.endsWith("/order") && init?.method === "POST") {
      const type = url.searchParams.get("type") ?? "";
      orderTypes.push(type);
      if (type === "TAKE_PROFIT_MARKET" && options.rejectTakeProfit) return error(400, "invalid take profit");
      return json({ orderId: orderTypes.length });
    }
    return json({});
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

function error(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message }),
    text: async () => message
  } as Response;
}
