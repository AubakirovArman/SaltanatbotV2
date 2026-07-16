import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter, BybitAdapter } from "./support/signedAdapters.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("emergency exchange account enumeration", () => {
  it("paginates every Bybit futures position and open order", async () => {
    const cursors: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor") ?? "";
      cursors.push(`${url.pathname}:${cursor}`);
      if (url.pathname.endsWith("/v5/position/list")) {
        return json({ retCode: 0, retMsg: "OK", result: cursor
          ? { list: [{ symbol: "ETHUSDT", side: "Sell", size: "2", avgPrice: "200", leverage: "3", positionIdx: 2 }] }
          : { list: [{ symbol: "BTCUSDT", side: "Buy", size: "1", avgPrice: "100", leverage: "2", positionIdx: 1 }], nextPageCursor: "positions-2" } });
      }
      if (url.pathname.endsWith("/v5/order/realtime")) {
        return json({ retCode: 0, retMsg: "OK", result: cursor
          ? { list: [bybitOrder("order-2", "ETHUSDT")] }
          : { list: [bybitOrder("order-1", "BTCUSDT")], nextPageCursor: "orders-2" } });
      }
      return json({ retCode: 0, retMsg: "OK", result: {} });
    });
    const adapter = new BybitAdapter("emergency", { apiKey: "key", apiSecret: "secret" }, "futures");

    expect(await adapter.positions()).toMatchObject([
      { symbol: "BTCUSDT", side: "long", positionIndex: 1, hedged: true },
      { symbol: "ETHUSDT", side: "short", positionIndex: 2, hedged: true }
    ]);
    expect((await adapter.orders()).map((order) => order.id)).toEqual(["order-1", "order-2"]);
    expect(cursors).toContain("/v5/position/list:positions-2");
    expect(cursors).toContain("/v5/order/realtime:orders-2");
  });

  it("closes the selected Binance hedge leg without an invalid reduceOnly flag", async () => {
    let submitted: URL | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/positionRisk")) {
        return json([{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", leverage: "2", positionSide: "LONG" }]);
      }
      if (url.pathname.endsWith("/exchangeInfo")) {
        return json({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", filters: [
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
          { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
          { filterType: "PRICE_FILTER", tickSize: "0.1", minPrice: "0.1", maxPrice: "1000000" },
          { filterType: "MIN_NOTIONAL", notional: "5" }
        ] }] });
      }
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        submitted = url;
        return json({ orderId: "closed" });
      }
      if (url.pathname.endsWith("/balance")) return json([{ asset: "USDT", balance: "1000", availableBalance: "1000" }]);
      return json({});
    });
    const adapter = new BinanceAdapter("emergency", { apiKey: "key", apiSecret: "secret" }, "futures");
    const result = await adapter.execute({
      action: "flatten",
      market: "futures",
      symbol: "BTCUSDT",
      side: "sell",
      positionSide: "long",
      type: "market",
      closePct: 100,
      reduceOnly: true,
      reason: "emergency"
    });

    expect(result.ok).toBe(true);
    expect(submitted?.searchParams.get("positionSide")).toBe("LONG");
    expect(submitted?.searchParams.has("reduceOnly")).toBe(false);
  });
});

function bybitOrder(orderId: string, symbol: string) {
  return { symbol, orderId, side: "Buy", orderType: "Limit", qty: "1", price: "90", reduceOnly: false, timeInForce: "GTC", createdTime: "1" };
}

function json(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
}
