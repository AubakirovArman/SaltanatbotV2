import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/trading/exchange/binance.js";
import { BybitAdapter } from "../src/trading/exchange/bybit.js";
import { normalizeBinanceOrderStatus, normalizeBybitOrderStatus } from "../src/trading/exchange/orderStatus.js";

afterEach(() => vi.unstubAllGlobals());

describe("exchange order status normalization", () => {
  it("maps Binance terminal and partial states", () => {
    expect(normalizeBinanceOrderStatus("NEW")).toBe("accepted");
    expect(normalizeBinanceOrderStatus("PARTIALLY_FILLED")).toBe("partially_filled");
    expect(normalizeBinanceOrderStatus("FILLED")).toBe("filled");
    expect(normalizeBinanceOrderStatus("CANCELED")).toBe("cancelled");
    expect(normalizeBinanceOrderStatus("EXPIRED_IN_MATCH")).toBe("expired");
  });

  it("maps Bybit terminal and partial states", () => {
    expect(normalizeBybitOrderStatus("New")).toBe("accepted");
    expect(normalizeBybitOrderStatus("PartiallyFilled")).toBe("partially_filled");
    expect(normalizeBybitOrderStatus("Filled")).toBe("filled");
    expect(normalizeBybitOrderStatus("PartiallyFilledCancelled")).toBe("cancelled");
    expect(normalizeBybitOrderStatus("Deactivated")).toBe("expired");
  });
});

describe("signed order status queries", () => {
  it("queries Binance by client id and parses aggregate execution", async () => {
    let requested = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested = String(input);
      return json({ orderId: 42, clientOrderId: "client-42", status: "PARTIALLY_FILLED", origQty: "2", executedQty: "0.75", avgPrice: "101.5", updateTime: 20 });
    });
    const adapter = new BinanceAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.orderStatus("BTCUSDT", { clientId: "client-42" })).resolves.toEqual({
      id: "42",
      clientId: "client-42",
      status: "partially_filled",
      qty: 2,
      filledQty: 0.75,
      avgFillPrice: 101.5,
      updatedAt: 20
    });
    const url = new URL(requested);
    expect(url.pathname).toBe("/fapi/v1/order");
    expect(url.searchParams.get("origClientOrderId")).toBe("client-42");
  });

  it("queries Bybit history by order id and parses a terminal result", async () => {
    let requested = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested = String(input);
      return json({ retCode: 0, retMsg: "OK", result: { list: [{ orderId: "99", orderLinkId: "client-99", orderStatus: "Filled", qty: "1", cumExecQty: "1", avgPrice: "100", updatedTime: "30" }] } });
    });
    const adapter = new BybitAdapter("bot", { apiKey: "key", apiSecret: "secret" }, "futures");

    await expect(adapter.orderStatus("BTCUSDT", { orderId: "99" })).resolves.toMatchObject({
      id: "99",
      status: "filled",
      filledQty: 1,
      avgFillPrice: 100,
      updatedAt: 30
    });
    const url = new URL(requested);
    expect(url.pathname).toBe("/v5/order/history");
    expect(url.searchParams.get("orderId")).toBe("99");
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
