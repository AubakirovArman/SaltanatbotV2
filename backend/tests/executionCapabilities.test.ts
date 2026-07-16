import { describe, expect, it } from "vitest";
import {
  canonicalExecutionValue,
  classifySignedExchangeRequest,
  ExecutionCapabilityError,
  normalizeSignedExchangeRequest,
  SIGNED_REQUEST_INVALID,
  SIGNED_REQUEST_UNSUPPORTED,
  signedExchangeRequestDigest,
  type SignedExchangeRequest
} from "../src/trading/executionCapabilities.js";

function request(overrides: Partial<SignedExchangeRequest> = {}): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/order/create",
    payload: {
      category: "linear",
      symbol: "BTCUSDT",
      side: "Buy",
      orderType: "Market",
      positionIdx: 0,
      qty: "0.01"
    },
    ...overrides
  };
}

describe("signed exchange request capability classification", () => {
  it("classifies every private capability from the exact route and payload", () => {
    expect(classifySignedExchangeRequest(request({ method: "GET", path: "/v5/account/wallet-balance", payload: { accountType: "UNIFIED" } }))).toEqual({
      capability: "private-read",
      action: "private.account.read",
      riskEffect: "none",
      requiresRulesFingerprint: false,
      requiresReduceOnlyProof: false
    });
    expect(classifySignedExchangeRequest(request())).toMatchObject({
      capability: "entry",
      action: "order.entry",
      riskEffect: "increase",
      symbol: "BTCUSDT"
    });
    expect(classifySignedExchangeRequest(request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "0.01", reduceOnly: true } }))).toMatchObject({
      capability: "reduce-only",
      action: "order.reduce",
      riskEffect: "reduce",
      requiresReduceOnlyProof: true
    });
    expect(classifySignedExchangeRequest(request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", positionIdx: 0, qty: "0.01", reduceOnly: true, triggerDirection: 2, triggerPrice: "70000" } }))).toMatchObject({
      capability: "protection",
      action: "order.protection",
      riskEffect: "reduce",
      requiresReduceOnlyProof: false
    });
    expect(classifySignedExchangeRequest(request({ path: "/v5/order/cancel", payload: { category: "linear", symbol: "BTCUSDT", orderId: "order-1" } }))).toMatchObject({
      capability: "cancel",
      action: "order.cancel",
      riskEffect: "unknown"
    });
    expect(classifySignedExchangeRequest(request({ path: "/v5/position/set-leverage", payload: { category: "linear", symbol: "BTCUSDT", buyLeverage: "2", sellLeverage: "2" } }))).toMatchObject({
      capability: "account-settings",
      action: "account.settings",
      riskEffect: "unknown"
    });
    expect(classifySignedExchangeRequest(request({ path: "/v5/account/borrow", payload: { coin: "USDT", amount: "100" } }))).toMatchObject({
      capability: "debt-actions",
      action: "debt.borrow",
      riskEffect: "increase"
    });
  });

  it("classifies supported Binance spot and futures shapes independently", () => {
    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "spot",
          method: "GET",
          path: "/api/v3/account",
          payload: {}
        })
      )
    ).toMatchObject({ capability: "private-read", action: "private.account.read", riskEffect: "none" });

    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/order",
          payload: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01" }
        })
      )
    ).toMatchObject({ capability: "entry", action: "order.entry", riskEffect: "increase" });

    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/order",
          payload: { symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: "0.01", reduceOnly: "true" }
        })
      )
    ).toMatchObject({ capability: "reduce-only", action: "order.reduce", riskEffect: "reduce" });

    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/order",
          payload: { symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", closePosition: "true", stopPrice: "60000" }
        })
      )
    ).toMatchObject({ capability: "protection", action: "order.protection", riskEffect: "reduce" });

    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          method: "DELETE",
          path: "/fapi/v1/allOpenOrders",
          payload: { symbol: "BTCUSDT" }
        })
      )
    ).toMatchObject({ capability: "cancel", action: "order.cancel" });

    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/leverage",
          payload: { symbol: "BTCUSDT", leverage: "3" }
        })
      )
    ).toMatchObject({ capability: "account-settings", action: "account.settings" });
  });

  it("covers private-stream, trading-stop, collateral and repay shapes", () => {
    expect(
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/listenKey",
          payload: {}
        })
      )
    ).toMatchObject({ capability: "private-read", action: "private.stream.manage" });
    expect(
      classifySignedExchangeRequest(
        request({
          path: "/v5/position/trading-stop",
          payload: {
            category: "linear",
            symbol: "BTCUSDT",
            tpslMode: "Full",
            positionIdx: 0,
            slOrderType: "Market",
            tpOrderType: "Market",
            stopLoss: "60000",
            slTriggerBy: "LastPrice"
          }
        })
      )
    ).toMatchObject({ capability: "protection", action: "order.protection" });
    expect(
      classifySignedExchangeRequest(
        request({
          path: "/v5/account/set-collateral-switch",
          payload: { coin: "BTC", collateralSwitch: "ON" }
        })
      )
    ).toMatchObject({ capability: "account-settings", action: "account.settings" });
    expect(
      classifySignedExchangeRequest(
        request({
          path: "/v5/account/no-convert-repay",
          payload: { coin: "USDT", repaymentType: "ALL" }
        })
      )
    ).toMatchObject({ capability: "debt-actions", action: "debt.repay", riskEffect: "reduce" });
  });

  it("covers every private route currently used by trading and telemetry clients", () => {
    const usedClientRoutes: SignedExchangeRequest[] = [
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/account", payload: {} },
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/account/commission", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "spot", method: "GET", path: "/sapi/v1/capital/config/getall", payload: {} },
      { venue: "binance", market: "spot", method: "GET", path: "/sapi/v1/margin/maxBorrowable", payload: { asset: "USDT" } },
      { venue: "binance", market: "spot", method: "GET", path: "/sapi/v1/margin/next-hourly-interest-rate", payload: { assets: "USDT", isIsolated: "FALSE" } },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v2/balance", payload: {} },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v2/positionRisk", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v2/positionRisk", payload: {} },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/accountConfig", payload: {} },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/feeBurn", payload: {} },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/commissionRate", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/openOrders", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/openOrders", payload: {} },
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/order", payload: { symbol: "BTCUSDT", orderId: "1" } },
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/order", payload: { symbol: "BTCUSDT", origClientOrderId: "client-1" } },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/openOrders", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/openOrders", payload: {} },
      { venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/order", payload: { symbol: "BTCUSDT", orderId: "1" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/listenKey", payload: {} },
      { venue: "binance", market: "futures", method: "PUT", path: "/fapi/v1/listenKey", payload: {} },
      { venue: "binance", market: "futures", method: "DELETE", path: "/fapi/v1/listenKey", payload: {} },
      { venue: "binance", market: "spot", method: "POST", path: "/api/v3/order", payload: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/order", payload: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01" } },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.01", price: "64000", timeInForce: "GTC", newClientOrderId: "entry-1" }
      },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", stopPrice: "60000", closePosition: "true", positionSide: "LONG", newClientOrderId: "stop-1" }
      },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", stopPrice: "70000", quantity: "0.005", reduceOnly: "true", newClientOrderId: "tp-1" }
      },
      { venue: "binance", market: "spot", method: "DELETE", path: "/api/v3/order", payload: { symbol: "BTCUSDT", orderId: "1" } },
      { venue: "binance", market: "futures", method: "DELETE", path: "/fapi/v1/order", payload: { symbol: "BTCUSDT", orderId: "1" } },
      { venue: "binance", market: "futures", method: "DELETE", path: "/fapi/v1/allOpenOrders", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/leverage", payload: { symbol: "BTCUSDT", leverage: "2" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/marginType", payload: { symbol: "BTCUSDT", marginType: "ISOLATED" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/positionSide/dual", payload: { dualSidePosition: "false" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/wallet-balance", payload: { accountType: "UNIFIED" } },
      { venue: "bybit", market: "spot", method: "GET", path: "/v5/account/wallet-balance", payload: { accountType: "UNIFIED", coin: "BTC" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/info", payload: {} },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/collateral-info", payload: {} },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/borrow-history", payload: { limit: 20 } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/fee-rate", payload: { category: "linear", symbol: "BTCUSDT" } },
      { venue: "bybit", market: "spot", method: "GET", path: "/v5/account/fee-rate", payload: { category: "spot", symbol: "BTCUSDT" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/asset/coin/query-info", payload: { coin: "BTC" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/position/list", payload: { category: "linear", symbol: "BTCUSDT" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/position/list", payload: { category: "linear", settleCoin: "USDT", limit: 200, cursor: "positions-2" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/order/realtime", payload: { category: "linear", symbol: "BTCUSDT", limit: 50 } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/order/realtime", payload: { category: "linear", settleCoin: "USDT", limit: 50, cursor: "orders-2" } },
      { venue: "bybit", market: "spot", method: "GET", path: "/v5/order/realtime", payload: { category: "spot", limit: 50 } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/order/history", payload: { category: "linear", symbol: "BTCUSDT", limit: 1, orderId: "order-1" } },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/order/history", payload: { category: "linear", symbol: "BTCUSDT", limit: 1, orderLinkId: "client-1" } },
      { venue: "bybit", market: "spot", method: "POST", path: "/v5/order/create", payload: { category: "spot", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.01", marketUnit: "baseCoin" } },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.01", positionIdx: 0, orderLinkId: "entry-1" }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Limit", qty: "0.01", price: "64000", timeInForce: "GTC", positionIdx: 0 }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "0.01", triggerPrice: "60000", triggerDirection: 2, reduceOnly: true, positionIdx: 0 }
      },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/order/cancel", payload: { category: "linear", symbol: "BTCUSDT", orderLinkId: "client-1" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/order/cancel-all", payload: { category: "linear", symbol: "BTCUSDT" } },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/position/trading-stop",
        payload: {
          category: "linear",
          symbol: "BTCUSDT",
          tpslMode: "Full",
          positionIdx: 0,
          slOrderType: "Market",
          tpOrderType: "Market",
          stopLoss: "60000",
          slTriggerBy: "LastPrice",
          takeProfit: "70000",
          tpTriggerBy: "LastPrice"
        }
      },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/position/set-leverage", payload: { category: "linear", symbol: "BTCUSDT", buyLeverage: "2", sellLeverage: "2" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/position/switch-isolated", payload: { category: "linear", symbol: "BTCUSDT", tradeMode: 1, buyLeverage: "2", sellLeverage: "2" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/position/switch-mode", payload: { category: "linear", symbol: "BTCUSDT", mode: 0 } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/borrow", payload: { coin: "USDT", amount: "100" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/repay", payload: { coin: "USDT", repaymentType: "ALL" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/repay", payload: { coin: "USDT", repaymentType: "FIXED", amount: "50" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/no-convert-repay", payload: { coin: "USDT", repaymentType: "ALL" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/set-collateral-switch", payload: { coin: "BTC", collateralSwitch: "ON" } }
    ];

    for (const usedClientRoute of usedClientRoutes) {
      expect(() => classifySignedExchangeRequest(usedClientRoute), `${usedClientRoute.venue} ${usedClientRoute.method} ${usedClientRoute.path}`).not.toThrow();
    }
  });

  it("produces a deterministic digest of the entire normalized request", () => {
    const left = request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Limit", positionIdx: 0, qty: "0.01", price: "64000", timeInForce: "GTC" } });
    const right = request({ payload: { timeInForce: "GTC", price: "64000", qty: "0.01", positionIdx: 0, orderType: "Limit", side: "Buy", symbol: "BTCUSDT", category: "linear" } });
    expect(signedExchangeRequestDigest(left)).toMatch(/^[0-9a-f]{64}$/);
    expect(signedExchangeRequestDigest(left)).toBe(signedExchangeRequestDigest(right));
    expect(signedExchangeRequestDigest(left)).not.toBe(
      signedExchangeRequestDigest(request({ path: "/v5/order/cancel", payload: { category: "linear", symbol: "BTCUSDT", orderId: "order-1" } }))
    );
    expect(signedExchangeRequestDigest(left)).not.toBe(signedExchangeRequestDigest(request({ ...left, payload: { ...left.payload, price: "64001" } })));
    expect(canonicalExecutionValue({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  });

  it("exports one immutable canonical descriptor that matches the serializable wire payload", () => {
    const mutablePayload: Record<string, unknown> = {
      symbol: "BTCUSDT",
      limit: 50,
      category: "linear"
    };
    const normalized = normalizeSignedExchangeRequest({
      venue: "bybit",
      market: "futures",
      method: "GET",
      path: "/v5/order/realtime",
      payload: mutablePayload
    });

    expect(normalized).toEqual({
      venue: "bybit",
      market: "futures",
      method: "GET",
      path: "/v5/order/realtime",
      payload: { category: "linear", limit: "50", symbol: "BTCUSDT" }
    });
    expect(Object.keys(normalized.payload)).toEqual(["category", "limit", "symbol"]);
    expect(JSON.stringify(normalized.payload)).toBe(canonicalExecutionValue(normalized.payload));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.payload)).toBe(true);

    mutablePayload.symbol = "ETHUSDT";
    expect(normalized.payload.symbol).toBe("BTCUSDT");
    expect(() => Object.assign(normalized.payload, { symbol: "ETHUSDT" })).toThrow();
    expect(signedExchangeRequestDigest({ ...normalized, payload: { symbol: "BTCUSDT", category: "linear", limit: "50" } })).toBe(
      signedExchangeRequestDigest(normalized)
    );
  });

  it("rejects unknown top-level fields and every explicit null or undefined", () => {
    const unknownTopLevel = { ...request(), accountId: "account-a" } as unknown as SignedExchangeRequest;
    const explicitUndefinedPayload = { ...request(), payload: undefined } as SignedExchangeRequest;
    const explicitNullPayload = { ...request(), payload: null } as unknown as SignedExchangeRequest;
    const nullField = request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: null } });
    const undefinedField = request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: undefined } });

    for (const invalidRequest of [unknownTopLevel, explicitUndefinedPayload, explicitNullPayload, nullField, undefinedField]) {
      expect(() => normalizeSignedExchangeRequest(invalidRequest)).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
      expect(() => signedExchangeRequestDigest(invalidRequest)).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    }
  });

  it("rejects route-specific extra keys instead of silently digesting them", () => {
    const invalidRequests: SignedExchangeRequest[] = [
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/account", payload: { symbol: "BTCUSDT" } },
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/leverage", payload: { symbol: "BTCUSDT", leverage: "2", reduceOnly: "true" } },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01", category: "linear" }
      },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/info", payload: { accountType: "UNIFIED" } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/account/borrow", payload: { coin: "USDT", amount: "10", confirm: true } },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.01", positionIdx: 0, closeOnTrigger: true }
      }
    ];

    for (const invalidRequest of invalidRequests) {
      expect(() => normalizeSignedExchangeRequest(invalidRequest)).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    }
  });

  it("enforces exact XOR identities for reads and cancellation", () => {
    const invalidRequests: SignedExchangeRequest[] = [
      { venue: "binance", market: "spot", method: "GET", path: "/api/v3/order", payload: { symbol: "BTCUSDT" } },
      {
        venue: "binance",
        market: "futures",
        method: "DELETE",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", orderId: "1", origClientOrderId: "client-1" }
      },
      { venue: "bybit", market: "futures", method: "GET", path: "/v5/order/history", payload: { category: "linear", symbol: "BTCUSDT", limit: 1 } },
      {
        venue: "bybit",
        market: "futures",
        method: "GET",
        path: "/v5/order/history",
        payload: { category: "linear", symbol: "BTCUSDT", limit: 1, orderId: "1", orderLinkId: "client-1" }
      },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/order/cancel", payload: { category: "linear", symbol: "BTCUSDT" } },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/cancel",
        payload: { category: "linear", symbol: "BTCUSDT", orderId: "1", orderLinkId: "client-1" }
      }
    ];

    for (const invalidRequest of invalidRequests) {
      expect(() => normalizeSignedExchangeRequest(invalidRequest)).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    }
  });

  it("enforces conditional wire fields and mutually exclusive route variants", () => {
    const invalidRequests: SignedExchangeRequest[] = [
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01", price: "64000" }
      },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.01", price: "64000" }
      },
      {
        venue: "binance",
        market: "futures",
        method: "POST",
        path: "/fapi/v1/order",
        payload: { symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", quantity: "0.01", closePosition: "true", stopPrice: "60000" }
      },
      {
        venue: "bybit",
        market: "spot",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "spot", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "0.01" }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Limit", qty: "0.01", price: "64000" }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/order/create",
        payload: { category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "0.01", triggerPrice: "60000" }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "GET",
        path: "/v5/position/list",
        payload: { category: "linear", symbol: "BTCUSDT", settleCoin: "USDT", limit: 200 }
      },
      {
        venue: "bybit",
        market: "futures",
        method: "POST",
        path: "/v5/position/trading-stop",
        payload: { category: "linear", symbol: "BTCUSDT", slTriggerBy: "LastPrice" }
      }
    ];

    for (const invalidRequest of invalidRequests) {
      expect(() => normalizeSignedExchangeRequest(invalidRequest)).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    }
  });

  it("fails closed for unknown venue, method, path and path aliases", () => {
    const unknownVenue = { ...request(), venue: "other" } as unknown as SignedExchangeRequest;
    const unknownMethod = { ...request(), method: "PATCH" } as unknown as SignedExchangeRequest;
    expect(() => classifySignedExchangeRequest(unknownVenue)).toThrowError(ExecutionCapabilityError);
    expect(() => classifySignedExchangeRequest(unknownMethod)).toThrowError(ExecutionCapabilityError);
    expect(() => classifySignedExchangeRequest(request({ path: "/v5/order/create/" }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_UNSUPPORTED }));
    expect(() => classifySignedExchangeRequest(request({ path: "/v5/order/create?category=linear" }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => classifySignedExchangeRequest(request({ method: "GET", path: "/v5/order/create" }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_UNSUPPORTED }));
  });

  it("fails closed for ambiguous, malformed and falsely reducing payloads", () => {
    expect(() => classifySignedExchangeRequest(request({ payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market" } }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => classifySignedExchangeRequest(request({ payload: { category: "spot", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "1" } }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => classifySignedExchangeRequest(request({ market: "spot", payload: { category: "spot", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "1", reduceOnly: true } }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => classifySignedExchangeRequest(request({ path: "/v5/position/trading-stop", payload: { category: "linear", symbol: "BTCUSDT" } }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() =>
      classifySignedExchangeRequest(
        request({
          venue: "binance",
          market: "futures",
          path: "/fapi/v1/order",
          payload: { symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: "1", reduceOnly: "yes" }
        })
      )
    ).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => signedExchangeRequestDigest(request({ payload: { category: "linear", value: undefined } }))).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
    expect(() => canonicalExecutionValue({ value: Number.NaN })).toThrowError(expect.objectContaining({ code: SIGNED_REQUEST_INVALID }));
  });
});
