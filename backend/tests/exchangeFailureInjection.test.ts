import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, scriptedFetch, textResponse } from "@saltanatbotv2/test-fixtures";
import { BinanceAdapter } from "../src/trading/exchange/binance.js";
import { BybitAdapter } from "../src/trading/exchange/bybit.js";
import { ExchangeTransportError } from "../src/trading/exchange/errors.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";
import { OrderLifecycle, type OrderLifecycleWriter } from "../src/trading/orderLifecycle.js";
import type { ExecOrder, OrderEventRecord, OrderJournalRecord } from "../src/trading/types.js";

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("exchange failure injection", () => {
  it("persists unknown when the connection drops during an order POST", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
      { match: "/order", respond: () => { throw new TypeError("socket closed after write"); } },
    ], () => jsonResponse({})));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const records: OrderJournalRecord[] = [];
    const events: OrderEventRecord[] = [];
    const writer: OrderLifecycleWriter = {
      upsertOrder: (record) => records.push(structuredClone(record)),
      insertEvent: (event) => events.push(structuredClone(event))
    };
    const lifecycle = new OrderLifecycle(writer);
    const order = marketOrder();

    await expect(lifecycle.execute(
      { botId: "bot", exchange: "binance", market: "futures" },
      order,
      () => adapter.execute(order)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });

    expect(records.map((record) => record.status)).toEqual(["intent", "unknown"]);
    expect(events.at(-1)?.data).toMatchObject({ status: "unknown", ok: false });
  });

  it("keeps a definitive HTTP 400 response as a normal rejection", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
    ], () => textResponse("invalid quantity", 400)));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute(marketOrder())).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/400.*invalid quantity/) });
  });

  it("treats a mutating HTTP 5xx response as ambiguous", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
    ], () => textResponse("upstream unavailable", 503)));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute(marketOrder())).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
  });

  it("applies the same ambiguous network contract to Bybit", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/v5/market/tickers", respond: () => jsonResponse({ result: { list: [{ lastPrice: "100" }] } }) },
      { match: "/v5/market/instruments-info", respond: () => jsonResponse({ retCode: 0, result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: {}, priceFilter: {} }] } }) },
      { match: "/v5/order/create", respond: () => { throw new TypeError("connection reset"); } },
    ], () => jsonResponse({ retCode: 0, retMsg: "OK", result: {} })));
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute(marketOrder())).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
  });

  it("marks mutating 5xx responses ambiguous but read failures retryable", () => {
    expect(new ExchangeTransportError("post failed", true)).toMatchObject({ ambiguous: true });
    expect(new ExchangeTransportError("read failed", false)).toMatchObject({ ambiguous: false });
  });
});

function marketOrder(): ExecOrder {
  return { action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, reason: "test" };
}
