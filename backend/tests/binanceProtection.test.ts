import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "./support/signedAdapters.js";
import { clearFilterCache } from "../src/trading/exchange/filters.js";

afterEach(() => {
  clearFilterCache();
  vi.unstubAllGlobals();
});

describe("Binance futures protection", () => {
  it("confirms protection only after every requested SL/TP order succeeds", async () => {
    const orderTypes: string[] = [];
    const clientOrderIds: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { clientOrderIds }));

    const result = await executeProtectedEntry();

    expect(result.ok).toBe(true);
    expect(result.protection).toEqual({
      requested: true,
      confirmed: true,
      entryOrderId: "1",
      stopOrderIds: ["2"],
      takeProfitOrderIds: ["3"],
      verification: "order_ids"
    });
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]);
    expect(clientOrderIds).toEqual(["entry-1", "entry-1-stop", "entry-1-tp-1"]);
  });

  it("preserves the entry ACK and submits a safety close when take-profit placement is rejected", async () => {
    const orderTypes: string[] = [];
    const cancelledOrderIds: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { rejectTakeProfit: true, cancelledOrderIds }));

    const result = await executeProtectedEntry();

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/take-profit rejected/i);
    expect(result.protection).toMatchObject({
      requested: true,
      confirmed: false,
      safetyCloseAttempted: true,
      safetyCloseConfirmed: true,
      safetyCloseOrderId: "4"
    });
    expect(result.pendingOrder).toMatchObject({ id: "1", qty: 1, reduceOnly: false });
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET", "MARKET"]);
    expect(cancelledOrderIds).toEqual(["2"]);
  });

  it("refuses to confirm protection when a stop acknowledgement omits its ID", async () => {
    const orderTypes: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { omitStopId: true }));

    const result = await executeProtectedEntry();

    expect(result).toMatchObject({
      ok: true,
      protection: { requested: true, confirmed: false, safetyCloseConfirmed: true }
    });
    expect(result.message).toMatch(/order ID.*emergency close.*accepted/i);
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "MARKET"]);
  });

  it("keeps a protection child unknown when its HTTP 200 acknowledgement is truncated", async () => {
    const orderTypes: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { truncateStop: true }));

    const result = await executeProtectedEntry();

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "1" },
      protection: {
        requested: true,
        confirmed: false,
        stopOrderIds: [],
        safetyCloseConfirmed: true,
        safetyCloseOrderId: "3"
      }
    });
    expect(result.protection?.message).toMatch(/not valid JSON/i);
    expect(orderTypes).toEqual(["MARKET", "STOP_MARKET", "MARKET"]);
  });

  it("keeps an accepted entry fail-closed when the emergency close is also rejected", async () => {
    const orderTypes: string[] = [];
    const clientOrderIds: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { rejectTakeProfit: true, rejectSafetyClose: true, clientOrderIds }));

    const result = await executeProtectedEntry();

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "1" },
      protection: {
        requested: true,
        confirmed: false,
        safetyCloseAttempted: true,
        safetyCloseConfirmed: false,
        safetyCloseClientId: "entry-1-safety"
      }
    });
    expect(result.message).toMatch(/entry was accepted.*emergency close failed.*unprotected position may remain/i);
    expect(result.message).not.toMatch(/entry (?:was )?closed/i);
    expect(clientOrderIds).toEqual(["entry-1", "entry-1-stop", "entry-1-tp-1", "entry-1-safety"]);
  });

  it("preserves an accepted close and both IDs when post-ACK state reads fail", async () => {
    const clientIds: string[] = [];
    let accepted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/positionRisk")) {
        if (accepted) return error(400, "position enrichment unavailable");
        return json([{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", leverage: "1" }]);
      }
      if (url.pathname.endsWith("/exchangeInfo")) {
        return json(binanceInstrumentInfo());
      }
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/balance")) return error(400, "account enrichment unavailable");
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        clientIds.push(url.searchParams.get("newClientOrderId") ?? "");
        accepted = true;
        return json({ orderId: 88 });
      }
      return json({});
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

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

    expect(clientIds).toEqual(["durable-close-1"]);
    expect(result).toMatchObject({
      ok: true,
      fills: [],
      pendingOrder: { id: "88", clientId: "durable-close-1", reduceOnly: true }
    });
    expect(result.message).toMatch(/awaiting authenticated execution accounting/i);
    expect(result.position).toMatchObject({ symbol: "BTCUSDT", qty: 1 });
    expect(result.account).toBeUndefined();
  });

  it("preserves an accepted protected entry when every post-ACK state read fails", async () => {
    const orderTypes: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { rejectEnrichmentReads: true }));

    const result = await executeProtectedEntry();

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "1", clientId: "entry-1" },
      protection: { confirmed: true, entryOrderId: "1", stopOrderIds: ["2"], takeProfitOrderIds: ["3"] }
    });
    expect(result.position).toBeUndefined();
    expect(result.account).toBeUndefined();
  });

  it("surfaces protection orders whose compensation cancellation failed", async () => {
    const orderTypes: string[] = [];
    vi.stubGlobal("fetch", binanceFetch(orderTypes, { rejectTakeProfit: true, rejectCancellation: true }));

    const result = await executeProtectedEntry();

    expect(result).toMatchObject({
      ok: true,
      pendingOrder: { id: "1" },
      protection: {
        confirmed: false,
        safetyCloseConfirmed: true,
        orphanProtectionOrderIds: ["2"]
      }
    });
    expect(result.protection?.message).toMatch(/cancellation was not confirmed.*2.*orphan protection may remain/i);
    expect(result.message).toMatch(/orphan protection may remain/i);
    expect(result.message).not.toMatch(/entry (?:was )?closed/i);
  });

  it("performs zero signed requests when exact, complete rules are unavailable", async () => {
    const signed: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.headers && "X-MBX-APIKEY" in (init.headers as Record<string, string>)) signed.push(url.pathname);
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json({ ...binanceInstrumentInfo(), symbols: [{ ...binanceInstrumentInfo().symbols[0], symbol: "ETHUSDT" }] });
      return json({});
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

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
    expect(result.message).toMatch(/0 exact rows/);
    expect(signed).toEqual([]);
  });

  it("preflights zero-quantity protection children before leverage or entry mutation", async () => {
    const signedMutations: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method && init.method !== "GET" && url.hostname.includes("binance")) signedMutations.push(url.pathname);
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json(binanceInstrumentInfo({ stepSize: "1", minQty: "1", minNotional: "1" }));
      return json({ orderId: 1, leverage: 5 });
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      leverage: 5,
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 0.1 }],
      reason: "test"
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/take-profit quantity quantizes to zero/);
    expect(signedMutations).toEqual([]);
  });

  it("uses distinct market/limit quantity rules and exact limit-price ticks", async () => {
    const submissions: URL[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) {
        return json(binanceInstrumentInfo({ stepSize: "0.001", marketStepSize: "0.01", tickSize: "0.05", minNotional: "1" }));
      }
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        submissions.push(url);
        return json({ orderId: submissions.length });
      }
      if (url.pathname.endsWith("/positionRisk")) return json([]);
      if (url.pathname.endsWith("/balance")) return json([{ asset: "USDT", balance: "1000" }]);
      return json({});
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

    await adapter.execute({ action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1.239, reason: "test" });
    await adapter.execute({ action: "open", market: "futures", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 1.239, price: 100.079, reason: "test" });

    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.searchParams.get("quantity")).toBe("1.23");
    expect(submissions[0]?.searchParams.has("price")).toBe(false);
    expect(submissions[1]?.searchParams.get("quantity")).toBe("1.239");
    expect(submissions[1]?.searchParams.get("price")).toBe("100.05");
  });

  it("rejects aggregate take-profit quantity above the prepared entry before signed I/O", async () => {
    const signedMutations: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method && init.method !== "GET" && url.hostname.includes("binance")) signedMutations.push(url.pathname);
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json(binanceInstrumentInfo());
      return json({ orderId: 1 });
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      type: "market",
      qty: 1,
      takeProfits: [
        { priceBasis: "price", price: 110, qtyBasis: "percent", qty: 60 },
        { priceBasis: "price", price: 120, qtyBasis: "percent", qty: 60 }
      ],
      reason: "test"
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/aggregate take-profit quantity exceeds/i);
    expect(signedMutations).toEqual([]);
  });

  it("binds entry and every protection child to the selected hedge leg", async () => {
    const submissions: URL[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json(binanceInstrumentInfo());
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        submissions.push(url);
        return json({ orderId: submissions.length });
      }
      if (url.pathname.endsWith("/positionRisk")) return json([]);
      if (url.pathname.endsWith("/balance")) return json([{ asset: "USDT", balance: "1000" }]);
      return json({});
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

    const result = await adapter.execute({
      action: "open",
      market: "futures",
      symbol: "BTCUSDT",
      side: "buy",
      positionSide: "long",
      type: "market",
      qty: 1,
      stop: { basis: "price", value: 95 },
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 100 }],
      reason: "test"
    });

    expect(result.protection?.confirmed).toBe(true);
    expect(submissions).toHaveLength(3);
    expect(submissions.every((url) => url.searchParams.get("positionSide") === "LONG")).toBe(true);
    expect(submissions[2]?.searchParams.has("reduceOnly")).toBe(false);
  });

  it("keeps exact reduce-only formatting, exempts futures dust notional, and records snapped close qty", async () => {
    let submitted: URL | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json(binanceInstrumentInfo({ marketStepSize: "0.01", minNotional: "5" }));
      if (url.pathname.endsWith("/positionRisk")) return json([{ symbol: "BTCUSDT", positionAmt: "0.019", entryPrice: "100", leverage: "1" }]);
      if (url.pathname.endsWith("/order") && init?.method === "POST") {
        submitted = url;
        return json({ orderId: 44 });
      }
      if (url.pathname.endsWith("/balance")) return json([{ asset: "USDT", balance: "1000" }]);
      return json({});
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

    const result = await adapter.execute({
      action: "close",
      market: "futures",
      symbol: "BTCUSDT",
      side: "sell",
      type: "market",
      closePct: 100,
      reduceOnly: true,
      reason: "test"
    });

    expect(result).toMatchObject({ ok: true, pendingOrder: { qty: 0.01, reduceOnly: true } });
    expect(submitted?.searchParams.get("quantity")).toBe("0.01");
  });

  it("does not emit unjournaled Binance chunks above the market cap", async () => {
    const mutations: URL[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
      if (url.pathname.endsWith("/exchangeInfo")) return json(binanceInstrumentInfo({ maxQty: "1" }));
      if (url.pathname.endsWith("/positionRisk")) return json([{ symbol: "BTCUSDT", positionAmt: "2", entryPrice: "100", leverage: "1" }]);
      if (init?.method && init.method !== "GET") mutations.push(url);
      return json({ orderId: 1 });
    });
    const adapter = new BinanceAdapter("bot-1", { apiKey: "key", apiSecret: "secret" }, "futures");

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
    expect(result.message).toMatch(/above maxQty/);
    expect(mutations).toEqual([]);
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
    clientId: "entry-1",
    protectionClientIds: {
      stop: "entry-1-stop",
      takeProfits: ["entry-1-tp-1"],
      safetyClose: "entry-1-safety"
    },
    stop: { basis: "price", value: 95 },
    takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 100 }],
    reason: "test"
  });
}

function binanceFetch(
  orderTypes: string[],
  options: {
    rejectTakeProfit?: boolean;
    omitStopId?: boolean;
    truncateStop?: boolean;
    rejectSafetyClose?: boolean;
    rejectCancellation?: boolean;
    rejectEnrichmentReads?: boolean;
    cancelledOrderIds?: string[];
    clientOrderIds?: string[];
  } = {}
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/ticker/price")) return json({ price: "100" });
    if (url.pathname.endsWith("/exchangeInfo")) {
      return json(binanceInstrumentInfo());
    }
    if (url.pathname.endsWith("/positionRisk")) return options.rejectEnrichmentReads ? error(400, "position enrichment unavailable") : json([]);
    if (url.pathname.endsWith("/balance")) return options.rejectEnrichmentReads ? error(400, "account enrichment unavailable") : json([{ asset: "USDT", balance: "1000" }]);
    if (url.pathname.endsWith("/account")) return json({ totalWalletBalance: "1000", totalUnrealizedProfit: "0" });
    if (url.pathname.endsWith("/openOrders")) return json([]);
    if (url.pathname.endsWith("/leverage")) return json({ leverage: 1 });
    if (url.pathname.endsWith("/order") && init?.method === "DELETE") {
      options.cancelledOrderIds?.push(url.searchParams.get("orderId") ?? "");
      if (options.rejectCancellation) return error(400, "cancel rejected");
      return json({ orderId: url.searchParams.get("orderId"), status: "CANCELED" });
    }
    if (url.pathname.endsWith("/order") && init?.method === "POST") {
      const type = url.searchParams.get("type") ?? "";
      orderTypes.push(type);
      options.clientOrderIds?.push(url.searchParams.get("newClientOrderId") ?? "");
      if (type === "TAKE_PROFIT_MARKET" && options.rejectTakeProfit) return error(400, "invalid take profit");
      if (type === "STOP_MARKET" && options.truncateStop) return new Response('{"orderId":', { status: 200 });
      if (type === "STOP_MARKET" && options.omitStopId) return json({});
      if (type === "MARKET" && url.searchParams.get("newClientOrderId")?.endsWith("-safety") && options.rejectSafetyClose) {
        return error(400, "emergency close rejected");
      }
      return json({ orderId: orderTypes.length });
    }
    return json({});
  };
}

function binanceInstrumentInfo(
  options: {
    stepSize?: string;
    marketStepSize?: string;
    tickSize?: string;
    minQty?: string;
    minNotional?: string;
    maxQty?: string;
  } = {}
) {
  const stepSize = options.stepSize ?? "0.001";
  const marketStepSize = options.marketStepSize ?? stepSize;
  const minQty = options.minQty ?? "0.001";
  return {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        filters: [
          { filterType: "LOT_SIZE", stepSize, minQty, maxQty: options.maxQty ?? "1000" },
          { filterType: "MARKET_LOT_SIZE", stepSize: marketStepSize, minQty, maxQty: options.maxQty ?? "1000" },
          { filterType: "PRICE_FILTER", tickSize: options.tickSize ?? "0.1", minPrice: "0.1", maxPrice: "1000000" },
          { filterType: "MIN_NOTIONAL", notional: options.minNotional ?? "5" }
        ]
      }
    ]
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
