import { afterEach, describe, expect, it, vi } from "vitest";
import { BybitAdapter } from "./support/signedAdapters.js";
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
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.includes("/v5/market/tickers")) {
        return json({ result: { list: [{ lastPrice: "100" }] } });
      }
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
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
      positionSide: "long",
      positionIndex: 1,
      type: "market",
      qty: 1,
      stop: { basis: "price", value: 95 },
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 100 }],
      reason: "test"
    });

    expect(result.ok).toBe(true);
    expect(result.protection).toEqual({ requested: true, confirmed: true, entryOrderId: "ok", verification: "exchange_ack" });
    const protection = calls.find((call) => call.url.includes("/v5/position/trading-stop"));
    expect(protection?.method).toBe("POST");
    expect(protection?.body).toMatchObject({
      category: "linear",
      symbol: "BTCUSDT",
      tpslMode: "Full",
      positionIdx: 1,
      stopLoss: "95",
      takeProfit: "110",
      slTriggerBy: "LastPrice",
      tpTriggerBy: "LastPrice"
    });
    const entry = calls.find((call) => call.url.includes("/v5/order/create"));
    expect(entry?.body?.positionIdx).toBe(1);
  });

  it("reports unconfirmed protection and submits a safety close when trading-stop is rejected", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      if (url.includes("/v5/position/trading-stop")) return json({ retCode: 10001, retMsg: "invalid stop" });
      if (url.includes("/v5/position/list")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      if (url.includes("/v5/account/wallet-balance")) return json({ retCode: 0, retMsg: "OK", result: { list: [{ totalEquity: "1000", totalAvailableBalance: "1000" }] } });
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
      clientId: "entry-protection-1",
      protectionClientIds: { safetyClose: "entry-protection-1-safety-child" },
      reason: "test"
    });

    expect(result.ok).toBe(true);
    expect(result.protection).toMatchObject({
      requested: true,
      confirmed: false,
      message: "Bybit: invalid stop",
      safetyCloseAttempted: true,
      safetyCloseConfirmed: true,
      safetyCloseOrderId: "ok",
      safetyCloseClientId: "entry-protection-1-safety-child"
    });
    expect(result.pendingOrder).toMatchObject({ id: "ok", clientId: "entry-protection-1", reduceOnly: false });
    const createCalls = calls.filter((call) => call.url.includes("/v5/order/create"));
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.body).toMatchObject({ side: "Buy", orderLinkId: "entry-protection-1" });
    expect(createCalls[1]?.body).toMatchObject({ side: "Sell", reduceOnly: true, orderLinkId: "entry-protection-1-safety-child" });
    expect(result.message).toMatch(/entry was accepted.*emergency close.*accepted.*paused/i);
  });

  it("does not place a blind safety close when an accepted entry acknowledgement omits the order ID", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      return json({ retCode: 0, retMsg: "OK", result: {} });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    await expect(adapter.execute({ action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, stop: { basis: "price", value: 95 }, clientId: "entry-missing-1", reason: "test" })).rejects.toMatchObject({
      name: "ExchangeTransportError",
      ambiguous: true
    });
    const createCalls = calls.filter((call) => call.url.includes("/v5/order/create"));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.body?.orderLinkId).toBe("entry-missing-1");
    expect(calls.some((call) => call.url.includes("/v5/position/trading-stop"))).toBe(false);
  });

  it("keeps position protection unconfirmed when its HTTP 200 acknowledgement is truncated", async () => {
    let createCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      if (url.includes("/v5/position/trading-stop")) return new Response('{"retCode":0,"retMsg":"OK","result":', { status: 200 });
      if (url.includes("/v5/order/create")) {
        createCount += 1;
        return json({ retCode: 0, retMsg: "OK", result: { orderId: createCount === 1 ? "entry-1" : "safety-1" } });
      }
      if (url.includes("/v5/position/list")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      if (url.includes("/v5/account/wallet-balance")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      return json({ retCode: 0, retMsg: "OK", result: {} });
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
      clientId: "entry-client",
      reason: "test"
    });

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "entry-1" },
      protection: {
        requested: true,
        confirmed: false,
        safetyCloseConfirmed: true,
        safetyCloseOrderId: "safety-1"
      }
    });
    expect(result.protection?.message).toMatch(/not valid JSON/i);
  });

  it("preserves an accepted close and both IDs when post-ACK state reads fail", async () => {
    const calls: FetchCall[] = [];
    let accepted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      if (url.includes("/v5/position/list")) {
        if (accepted) return json({ retCode: 10001, retMsg: "position enrichment unavailable" });
        return json({ retCode: 0, retMsg: "OK", result: { list: [{ side: "Buy", size: "1", avgPrice: "100", leverage: "1", positionIdx: 0 }] } });
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return json({ retCode: 10001, retMsg: "account enrichment unavailable" });
      }
      if (url.includes("/v5/order/create")) accepted = true;
      return json({ retCode: 0, retMsg: "OK", result: { orderId: "close-88" } });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "close",
      market: "futures",
      symbol: "BTCUSDT",
      side: "sell",
      type: "market",
      closePct: 100,
      reduceOnly: true,
      clientId: "durable-close-1",
      reason: "test"
    });

    const create = calls.find((call) => call.url.includes("/v5/order/create"));
    expect(create?.body).toMatchObject({ side: "Sell", reduceOnly: true, orderLinkId: "durable-close-1" });
    expect(result).toMatchObject({
      ok: true,
      fills: [],
      pendingOrder: { id: "close-88", clientId: "durable-close-1", reduceOnly: true }
    });
    expect(result.message).toMatch(/awaiting authenticated execution accounting/i);
    expect(result.position).toMatchObject({ symbol: "BTCUSDT", qty: 1 });
    expect(result.account).toBeUndefined();
  });

  it("preserves a protected entry when every post-ACK state read fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      if (url.includes("/v5/order/create")) return json({ retCode: 0, retMsg: "OK", result: { orderId: "entry-ack" } });
      if (url.includes("/v5/position/trading-stop")) return json({ retCode: 0, retMsg: "OK", result: {} });
      return json({ retCode: 10001, retMsg: "state enrichment unavailable" });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      clientId: "entry-client",
      stop: { basis: "price", value: 95 },
      reason: "test"
    });

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "entry-ack", clientId: "entry-client" },
      protection: { confirmed: true, entryOrderId: "entry-ack" }
    });
    expect(result.position).toBeUndefined();
    expect(result.account).toBeUndefined();
  });

  it("preserves the entry ACK and explicit safety identity when the safety close is rejected", async () => {
    let createCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        return json(bybitInstrumentInfo());
      }
      if (url.includes("/v5/position/trading-stop")) return json({ retCode: 10001, retMsg: "invalid stop" });
      if (url.includes("/v5/order/create")) {
        createCount += 1;
        return createCount === 1 ? json({ retCode: 0, retMsg: "OK", result: { orderId: "entry-accepted" } }) : json({ retCode: 10001, retMsg: "safety close rejected" });
      }
      return json({ retCode: 10001, retMsg: "state unavailable" });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      clientId: "entry-client",
      protectionClientIds: { safetyClose: "safety-child-client" },
      stop: { basis: "price", value: 95 },
      reason: "test"
    });

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "entry-accepted", clientId: "entry-client" },
      protection: {
        confirmed: false,
        entryOrderId: "entry-accepted",
        safetyCloseConfirmed: false,
        safetyCloseClientId: "safety-child-client"
      }
    });
    expect(result.message).toMatch(/emergency close failed.*unprotected position may remain/i);
    expect(result.message).not.toMatch(/entry (?:was )?closed/i);
  });

  it("performs zero signed requests when exact complete rules are unavailable", async () => {
    const signed: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.headers as Record<string, string> | undefined)?.["X-BAPI-API-KEY"]) signed.push(url);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) {
        const payload = bybitInstrumentInfo();
        (payload.result.list[0]!.lotSizeFilter as { maxMktOrderQty?: string }).maxMktOrderQty = undefined;
        return json(payload);
      }
      return json({ retCode: 0, retMsg: "OK", result: { orderId: "unexpected" } });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      leverage: 5,
      reason: "test"
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/market maxOrderQty/);
    expect(signed).toEqual([]);
  });

  it("enforces market quantity caps separately from exact limit price ticks", async () => {
    const creates: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) return json(bybitInstrumentInfo({ marketMaxQty: "1", tickSize: "0.05" }));
      if (url.includes("/v5/order/create")) {
        creates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ retCode: 0, retMsg: "OK", result: { orderId: "limit-1" } });
      }
      if (url.includes("/v5/position/list")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      if (url.includes("/v5/account/wallet-balance")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      return json({ retCode: 0, retMsg: "OK", result: {} });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const market = await adapter.execute({ action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 2, reason: "test" });
    const limit = await adapter.execute({ action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 2, price: 100.079, reason: "test" });

    expect(market).toMatchObject({ ok: false });
    expect(market.message).toMatch(/maxQty/);
    expect(creates).toEqual([expect.objectContaining({ orderType: "Limit", qty: "2", price: "100.05" })]);
    expect(limit).toMatchObject({ ok: true });
  });

  it("rejects partial Full-mode take-profit before leverage or order mutation", async () => {
    const signedMutations: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.headers as Record<string, string> | undefined)?.["X-BAPI-API-KEY"] && init?.method !== "GET") {
        signedMutations.push(url);
      }
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) return json(bybitInstrumentInfo());
      return json({ retCode: 0, retMsg: "OK", result: { orderId: "unexpected" } });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      leverage: 5,
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 50 }],
      reason: "test"
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/requires exactly 100%/i);
    expect(signedMutations).toEqual([]);
  });

  it("fails closed above Bybit max quantity because server-side split children are not durably tracked", async () => {
    const creates: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v5/market/tickers")) return json({ result: { list: [{ lastPrice: "100" }] } });
      if (url.includes("/v5/market/instruments-info")) return json(bybitInstrumentInfo({ marketMaxQty: "1" }));
      if (url.includes("/v5/position/list")) {
        return json({ retCode: 0, retMsg: "OK", result: { list: [{ side: "Buy", size: "2", avgPrice: "100", leverage: "1", positionIdx: 0 }] } });
      }
      if (url.includes("/v5/order/create")) {
        creates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ retCode: 0, retMsg: "OK", result: { orderId: "close-auto-split" } });
      }
      if (url.includes("/v5/account/wallet-balance")) return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      return json({ retCode: 0, retMsg: "OK", result: {} });
    });
    const adapter = new BybitAdapter("bot-1", { apiKey: "test-key", apiSecret: "test-secret" }, "futures");

    const result = await adapter.execute({
      action: "flatten",
      market: "futures",
      symbol: "BTCUSDT",
      side: "sell",
      type: "market",
      closePct: 100,
      reduceOnly: true,
      reason: "emergency"
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/above maxQty.*durable chunk intents/i);
    expect(creates).toEqual([]);
  });
});

function bybitInstrumentInfo(options: { marketMaxQty?: string; tickSize?: string } = {}) {
  return {
    retCode: 0,
    result: {
      list: [
        {
          symbol: "BTCUSDT",
          status: "Trading",
          lotSizeFilter: {
            qtyStep: "0.001",
            minOrderQty: "0.001",
            maxOrderQty: "1000",
            maxMktOrderQty: options.marketMaxQty ?? "1000",
            minNotionalValue: "5"
          },
          priceFilter: { tickSize: options.tickSize ?? "0.1", minPrice: "0.1", maxPrice: "1000000" }
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
