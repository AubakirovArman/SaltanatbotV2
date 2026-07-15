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

  it("persists unknown when Binance returns HTTP 200 with a truncated order acknowledgement", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
      { match: "/order", respond: () => new Response('{"orderId":', { status: 200 }) },
    ], () => jsonResponse({})));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const h = lifecycleHarness();
    const order = marketOrder();

    await expect(h.lifecycle.execute(
      { botId: "bot", exchange: "binance", market: "futures" },
      order,
      () => adapter.execute(order)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });

    expect(h.records.map((record) => record.status)).toEqual(["intent", "unknown"]);
    expect(h.events.at(-1)?.data).toMatchObject({ status: "unknown", ok: false });
  });

  it("persists unknown when Binance cannot read an HTTP 200 mutation body", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
      { match: "/order", respond: () => unreadableResponse() },
    ], () => jsonResponse({})));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const h = lifecycleHarness();
    const order = marketOrder();

    await expect(h.lifecycle.execute(
      { botId: "bot", exchange: "binance", market: "futures" },
      order,
      () => adapter.execute(order)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
    expect(h.records.at(-1)).toMatchObject({ status: "unknown", clientId: order.clientId });
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

  it("persists unknown when Bybit returns HTTP 200 with malformed JSON", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/v5/market/tickers", respond: () => jsonResponse({ result: { list: [{ lastPrice: "100" }] } }) },
      { match: "/v5/market/instruments-info", respond: () => jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: {}, priceFilter: {} }] } }) },
      { match: "/v5/order/create", respond: () => new Response('{"retCode":0,"retMsg":"OK","result":', { status: 200 }) },
    ], () => jsonResponse({ retCode: 0, retMsg: "OK", result: {} })));
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const h = lifecycleHarness();
    const order = marketOrder();

    await expect(h.lifecycle.execute(
      { botId: "bot", exchange: "bybit", market: "futures" },
      order,
      () => adapter.execute(order)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
    expect(h.records.map((record) => record.status)).toEqual(["intent", "unknown"]);
  });

  it("persists unknown when Bybit cannot read an HTTP 200 mutation body", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/v5/market/tickers", respond: () => jsonResponse({ result: { list: [{ lastPrice: "100" }] } }) },
      { match: "/v5/market/instruments-info", respond: () => jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: {}, priceFilter: {} }] } }) },
      { match: "/v5/order/create", respond: () => unreadableResponse() },
    ], () => jsonResponse({ retCode: 0, retMsg: "OK", result: {} })));
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const h = lifecycleHarness();
    const order = marketOrder();

    await expect(h.lifecycle.execute(
      { botId: "bot", exchange: "bybit", market: "futures" },
      order,
      () => adapter.execute(order)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
    expect(h.records.at(-1)).toMatchObject({ status: "unknown", clientId: order.clientId });
  });

  it("keeps Binance and Bybit cancellation intents unknown when their success acknowledgements cannot be decoded", async () => {
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/fapi/v1/allOpenOrders", respond: () => new Response('{"code":', { status: 200 }) }
    ], () => jsonResponse({})));
    const binance = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const binanceHarness = lifecycleHarness();
    const binanceCancel = cancelOrder();
    await expect(binanceHarness.lifecycle.execute(
      { botId: "bot", exchange: "binance", market: "futures" },
      binanceCancel,
      () => binance.execute(binanceCancel)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
    expect(binanceHarness.records.map((record) => record.status)).toEqual(["intent", "unknown"]);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/v5/order/cancel-all", respond: () => unreadableResponse() }
    ], () => jsonResponse({ retCode: 0, retMsg: "OK", result: {} })));
    const bybit = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    const bybitHarness = lifecycleHarness();
    const bybitCancel = cancelOrder();
    await expect(bybitHarness.lifecycle.execute(
      { botId: "bot", exchange: "bybit", market: "futures" },
      bybitCancel,
      () => bybit.execute(bybitCancel)
    )).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
    expect(bybitHarness.records.map((record) => record.status)).toEqual(["intent", "unknown"]);
  });

  it("treats successful order responses without venue order IDs as ambiguous schema failures", async () => {
    const binance = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/ticker/price", respond: () => jsonResponse({ price: "100" }) },
      { match: "/exchangeInfo", respond: () => jsonResponse({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }) },
    ], () => jsonResponse({ status: "NEW" })));
    await expect(binance.execute(marketOrder())).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });

    vi.unstubAllGlobals();
    clearFilterCache();
    vi.stubGlobal("fetch", scriptedFetch([
      { match: "/v5/market/tickers", respond: () => jsonResponse({ result: { list: [{ lastPrice: "100" }] } }) },
      { match: "/v5/market/instruments-info", respond: () => jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: {}, priceFilter: {} }] } }) },
    ], () => jsonResponse({ retCode: 0, retMsg: "OK", result: {} })));
    const bybit = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");
    await expect(bybit.execute(marketOrder())).rejects.toMatchObject({ name: "ExchangeTransportError", ambiguous: true });
  });

  it("fails closed before Binance entry when requested leverage cannot be confirmed", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/leverage")) return textResponse('{"code":-1000,"msg":"leverage unavailable"}', 400);
      if (url.pathname.endsWith("/positionRisk")) return jsonResponse([{ symbol: "BTCUSDT", leverage: "10", positionAmt: "0" }]);
      return jsonResponse({});
    }));
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute({ ...marketOrder(), leverage: 3 })).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/leverage unavailable/) });
    expect(paths.some((path) => path.endsWith("/order"))).toBe(false);
  });

  it("fails closed before Bybit entry when requested leverage cannot be reconciled", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/set-leverage")) return jsonResponse({ retCode: 10001, retMsg: "leverage unavailable", result: {} });
      if (url.pathname.endsWith("/position/list")) return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ leverage: "10" }] } });
      return jsonResponse({ retCode: 0, retMsg: "OK", result: {} });
    }));
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute({ ...marketOrder(), leverage: 3 })).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/leverage unavailable/) });
    expect(paths.some((path) => path.endsWith("/order/create"))).toBe(false);
  });

  it("accepts an exact Bybit leverage reconciliation after an already-set response", async () => {
    let created = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/set-leverage")) return jsonResponse({ retCode: 110043, retMsg: "Set leverage not modified", result: {} });
      if (url.pathname.endsWith("/position/list")) return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ side: "", size: "0", avgPrice: "0", leverage: "3" }] } });
      if (url.pathname.endsWith("/market/tickers")) return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ lastPrice: "100" }] } });
      if (url.pathname.endsWith("/market/instruments-info")) return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lotSizeFilter: {}, priceFilter: {} }] } });
      if (url.pathname.endsWith("/order/create")) {
        created += 1;
        return jsonResponse({ retCode: 0, retMsg: "OK", result: { orderId: "accepted" } });
      }
      if (url.pathname.endsWith("/account/wallet-balance")) return jsonResponse({ retCode: 0, retMsg: "OK", result: { list: [{ totalEquity: "1000", totalAvailableBalance: "1000" }] } });
      return jsonResponse({ retCode: 0, retMsg: "OK", result: {} });
    }));
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.execute({ ...marketOrder(), leverage: 3 })).resolves.toMatchObject({ ok: true });
    expect(created).toBe(1);
  });

  it("rejects unsupported live actions instead of falling through to an entry", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetcher);
    const order: ExecOrder = { ...marketOrder(), action: "chporders" };
    await expect(new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures").execute(order)).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/not supported/) });
    await expect(new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures").execute(order)).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/not supported/) });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks mutating 5xx responses ambiguous but read failures retryable", () => {
    expect(new ExchangeTransportError("post failed", true)).toMatchObject({ ambiguous: true });
    expect(new ExchangeTransportError("read failed", false)).toMatchObject({ ambiguous: false });
  });
});

function marketOrder(): ExecOrder {
  return { action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, reason: "test" };
}

function cancelOrder(): ExecOrder {
  return { action: "cancelall", market: "futures", symbol: "BTCUSDT", type: "market", reason: "test" };
}

function lifecycleHarness() {
  const records: OrderJournalRecord[] = [];
  const events: OrderEventRecord[] = [];
  const lifecycle = new OrderLifecycle({
    upsertOrder: (record) => records.push(structuredClone(record)),
    insertEvent: (event) => events.push(structuredClone(event))
  });
  return { lifecycle, records, events };
}

function unreadableResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => { throw new TypeError("response stream terminated"); }
  } as Response;
}
