import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";
import type { NormalizedSignedExchangeRequest } from "../src/trading/executionCapabilities.js";
import {
  parseBinanceOrderUpdate,
  parseBybitExecutionUpdates,
  parseBybitOrderUpdates,
  subscribeBinanceOrders as subscribeBinanceOrdersProduction,
  subscribeBybitOrders as subscribeBybitOrdersProduction
} from "../src/trading/exchange/privateOrderStreams.js";
import {
  DENY_SIGNED_REQUEST_AUTHORIZER,
  type SignedRequestAuthorizer
} from "../src/trading/exchange/signedRequestGate.js";
import { signedRequestAuthorizerForTests } from "./support/signedRequestAuthorizer.js";

const FUTURE_LIVE_POLICY = runtimePolicyFromConfig({ runtimeProfile: "private-live" });
const subscribeBinanceOrders: typeof subscribeBinanceOrdersProduction = (keys, callbacks, context, dependencies = {}) =>
  subscribeBinanceOrdersProduction(keys, callbacks, context, { ...dependencies, runtimePolicy: FUTURE_LIVE_POLICY });
const subscribeBybitOrders: typeof subscribeBybitOrdersProduction = (keys, callbacks, context, dependencies = {}) =>
  subscribeBybitOrdersProduction(keys, callbacks, context, { ...dependencies, runtimePolicy: FUTURE_LIVE_POLICY });

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 1;
  closeCount = 0;
  send(value: string) { this.sent.push(value); }
  close() {
    this.closeCount += 1;
    this.readyState = 3;
  }
}

afterEach(() => vi.useRealTimers());

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("private order stream payload normalization", () => {
  it("normalizes a Binance ORDER_TRADE_UPDATE aggregate snapshot", () => {
    expect(parseBinanceOrderUpdate({
      e: "ORDER_TRADE_UPDATE",
      E: 170,
      T: 169,
      o: { i: 42, c: "client-42", X: "PARTIALLY_FILLED", q: "2", z: "0.75", ap: "101.5", T: 168 }
    })).toEqual({
      id: "42",
      clientId: "client-42",
      status: "partially_filled",
      qty: 2,
      filledQty: 0.75,
      avgFillPrice: 101.5,
      updatedAt: 168
    });
    expect(parseBinanceOrderUpdate({ e: "ACCOUNT_UPDATE" })).toBeUndefined();
  });

  it("normalizes every Bybit order row and skips malformed rows", () => {
    expect(parseBybitOrderUpdates({
      topic: "order.linear",
      creationTime: 200,
      data: [
        { orderId: "venue-1", orderLinkId: "client-1", orderStatus: "Filled", qty: "1", cumExecQty: "1", avgPrice: "99", updatedTime: "190" },
        { orderStatus: "New" }
      ]
    })).toEqual([{
      id: "venue-1",
      clientId: "client-1",
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 99,
      updatedAt: 190
    }]);
    expect(parseBybitExecutionUpdates({
      topic: "execution.linear",
      creationTime: 201,
      data: [{ orderId: "venue-1", orderLinkId: "client-1", orderQty: "1", leavesQty: "0.25", execPrice: "101", execTime: "200" }]
    })).toEqual([{
      id: "venue-1",
      clientId: "client-1",
      status: "partially_filled",
      qty: 1,
      filledQty: 0.75,
      updatedAt: 200
    }]);
  });

  it("preserves deduplicatable execution fees, fee assets and realized PnL", () => {
    expect(parseBinanceOrderUpdate({
      e: "ORDER_TRADE_UPDATE",
      T: 500,
      o: {
        i: 42, c: "client-42", X: "PARTIALLY_FILLED", x: "TRADE", q: "2", z: "0.75", ap: "101.5",
        s: "BTCUSDT", t: 9001, l: "0.25", L: "102", n: "0.0102", N: "USDT", rp: "1.5", S: "SELL", T: 499
      }
    })).toMatchObject({
      execution: {
        id: "binance:BTCUSDT:9001", qty: 0.25, price: 102, fee: 0.0102, feeAsset: "USDT",
        realizedPnl: 1.5, side: "sell", ts: 499
      }
    });

    expect(parseBybitExecutionUpdates({
      topic: "execution.linear",
      creationTime: 600,
      data: [{
        orderId: "venue-1", orderLinkId: "client-1", orderQty: "1", leavesQty: "0.4",
        execId: "exec-1", execQty: "0.2", execPrice: "99", execFee: "0.0198",
        feeCurrency: "USDT", closedPnl: "-2.5", side: "Sell", execTime: "590"
      }]
    })[0]).toMatchObject({
      status: "partially_filled",
      execution: {
        id: "bybit:exec-1", qty: 0.2, price: 99, fee: 0.0198, feeAsset: "USDT",
        realizedPnl: -2.5, side: "sell", ts: 590
      }
    });
  });
});

describe("Binance authenticated order stream", () => {
  it("creates a listenKey, streams snapshots and reconnects with polling status", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const requests: NormalizedSignedExchangeRequest[] = [];
    const controller = new AbortController();
    const authorizer = signedRequestAuthorizerForTests({
      maxConsumes: 3,
      onConsume: (request) => requests.push(request)
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ listenKey: "listen-secret" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const snapshots: unknown[] = [];
    const connections: Array<[boolean, string]> = [];
    const subscription = await subscribeBinanceOrders(
      { apiKey: "api-key", apiSecret: "api-secret" },
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onConnection: (connected, message) => connections.push([connected, message])
      },
      { authorizer, signal: controller.signal },
      {
        fetch: fetchMock as typeof fetch,
        random: () => 0,
        createSocket: (url) => {
          expect(url).toContain("/private/ws/listen-secret");
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        }
      }
    );

    expect(fetchMock).toHaveBeenCalledWith("https://fapi.binance.com/fapi/v1/listenKey", expect.objectContaining({
      method: "POST",
      headers: { "X-MBX-APIKEY": "api-key" }
    }));
    sockets[0].emit("open");
    expect(subscription.connected()).toBe(true);
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      e: "ORDER_TRADE_UPDATE",
      T: 5,
      o: { i: 1, c: "c1", X: "FILLED", q: "1", z: "1", ap: "100", T: 5 }
    })));
    expect(snapshots).toHaveLength(1);

    sockets[0].emit("close");
    expect(subscription.connected()).toBe(false);
    expect(connections.at(-1)?.[1]).toMatch(/polling fallback/i);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1].emit("open");
    expect(subscription.connected()).toBe(true);
    subscription.close();
    await flushMicrotasks();
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "DELETE"]);
  });

  it("consumes a separate exact permit for POST, PUT and DELETE listenKey management", async () => {
    vi.useFakeTimers();
    const requests: NormalizedSignedExchangeRequest[] = [];
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ listenKey: "listen-secret" }), { status: 200 })
        : new Response("{}", { status: 200 })
    );
    const subscription = await subscribeBinanceOrders(
      { apiKey: "api-key", apiSecret: "api-secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      {
        authorizer: signedRequestAuthorizerForTests({
          maxConsumes: 3,
          onConsume: (request) => requests.push(request)
        }),
        signal: controller.signal
      },
      {
        fetch: fetchMock as typeof fetch,
        createSocket: () => new FakeSocket() as unknown as WebSocket
      }
    );

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await flushMicrotasks();
    subscription.close();
    await flushMicrotasks();

    expect(requests).toEqual([
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/listenKey", payload: {} },
      { venue: "binance", market: "futures", method: "PUT", path: "/fapi/v1/listenKey", payload: {} },
      { venue: "binance", market: "futures", method: "DELETE", path: "/fapi/v1/listenKey", payload: {} }
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "PUT", "DELETE"]);
  });

  it("performs no fetch or socket construction when authorization is denied", async () => {
    const fetchMock = vi.fn();
    const createSocket = vi.fn();
    const controller = new AbortController();

    await expect(subscribeBinanceOrders(
      { apiKey: "api-key", apiSecret: "api-secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      { authorizer: DENY_SIGNED_REQUEST_AUTHORIZER, signal: controller.signal },
      { fetch: fetchMock as typeof fetch, createSocket: createSocket as never }
    )).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("does not issue a keepalive fetch when its dedicated permit is denied", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ listenKey: "listen-secret" }), { status: 200 })
        : new Response("{}", { status: 200 })
    );
    const subscription = await subscribeBinanceOrders(
      { apiKey: "api-key", apiSecret: "api-secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      {
        authorizer: signedRequestAuthorizerForTests({ maxConsumes: 1 }),
        signal: controller.signal
      },
      {
        fetch: fetchMock as typeof fetch,
        random: () => 0,
        createSocket: () => new FakeSocket() as unknown as WebSocket
      }
    );

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await flushMicrotasks();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST"]);

    controller.abort();
    expect(subscription.connected()).toBe(false);
  });

  it("aborts a pending permit before it can fetch or create a socket", async () => {
    const fetchMock = vi.fn();
    const createSocket = vi.fn();
    const controller = new AbortController();
    let release = () => {};
    const authorizer = {
      consume: (_request: NormalizedSignedExchangeRequest, afterConsume: () => unknown) =>
        new Promise<unknown>((resolve, reject) => {
          release = () => {
            try {
              resolve(afterConsume());
            } catch (error) {
              reject(error);
            }
          };
        })
    } as SignedRequestAuthorizer;

    const pending = subscribeBinanceOrders(
      { apiKey: "api-key", apiSecret: "api-secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      { authorizer, signal: controller.signal },
      { fetch: fetchMock as typeof fetch, createSocket: createSocket as never }
    );
    controller.abort();
    release();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });
});

describe("Bybit authenticated order stream", () => {
  it("authenticates, subscribes, heartbeats and emits normalized snapshots", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const controller = new AbortController();
    const snapshots: unknown[] = [];
    const connections: Array<[boolean, string]> = [];
    const now = 1_000;
    const subscription = await subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onConnection: (connected, message) => connections.push([connected, message])
      },
      { authorizer: signedRequestAuthorizerForTests(), signal: controller.signal },
      { now: () => now, random: () => 0, createSocket: () => socket as unknown as WebSocket }
    );

    socket.emit("open");
    expect(socket.sent).toHaveLength(1);
    const auth = JSON.parse(socket.sent[0]) as { op: string; args: [string, number, string] };
    const expires = now + 10_000;
    expect(auth).toEqual({
      op: "auth",
      args: ["key", expires, createHmac("sha256", "secret").update(`GET/realtime${expires}`).digest("hex")]
    });

    socket.emit("message", Buffer.from(JSON.stringify({ op: "auth", success: true })));
    socket.emit("message", Buffer.from(JSON.stringify({ op: "auth", success: true })));
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1])).toEqual({ op: "subscribe", args: ["order", "execution"] });
    socket.emit("message", Buffer.from(JSON.stringify({ op: "subscribe", success: true })));
    socket.emit("message", Buffer.from(JSON.stringify({ op: "subscribe", success: true })));
    expect(socket.sent).toHaveLength(2);
    expect(subscription.connected()).toBe(true);
    expect(connections.at(-1)?.[0]).toBe(true);

    socket.emit("message", Buffer.from(JSON.stringify({
      topic: "order",
      creationTime: 10,
      data: [{ orderId: "v1", orderLinkId: "c1", orderStatus: "Cancelled", qty: "2", cumExecQty: "1", avgPrice: "100", updatedTime: "9" }]
    })));
    expect(snapshots).toMatchObject([{ id: "v1", clientId: "c1", status: "cancelled", filledQty: 1 }]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent).toHaveLength(3);
    expect(JSON.parse(socket.sent[2])).toEqual({ op: "ping" });
    subscription.close();
  });

  it("authorizes the exact pseudo-request again on reconnect and fences the stale socket", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const requests: NormalizedSignedExchangeRequest[] = [];
    const controller = new AbortController();
    let now = 1_000;
    const subscription = await subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      {
        authorizer: signedRequestAuthorizerForTests({
          maxConsumes: 2,
          onConsume: (request) => requests.push(request)
        }),
        signal: controller.signal
      },
      {
        now: () => now,
        random: () => 0,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        }
      }
    );

    sockets[0].emit("open");
    expect(sockets[0].sent).toHaveLength(1);
    sockets[0].emit("close");
    now = 5_000;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sockets).toHaveLength(2);
    sockets[1].emit("open");
    expect(requests).toEqual([
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/private/ws/auth", payload: { expires: 11_000 } },
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/private/ws/auth", payload: { expires: 15_000 } }
    ]);
    expect(sockets[1].sent).toHaveLength(1);

    sockets[0].emit("message", Buffer.from(JSON.stringify({ op: "auth", success: true })));
    sockets[0].emit("open");
    expect(sockets[0].sent).toHaveLength(1);
    subscription.close();
  });

  it("performs no socket construction or send when authorization is denied", async () => {
    const createSocket = vi.fn();
    const createHmacMock = vi.fn();
    const controller = new AbortController();

    await expect(subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      { authorizer: DENY_SIGNED_REQUEST_AUTHORIZER, signal: controller.signal },
      { now: () => 1_000, createHmac: createHmacMock as never, createSocket: createSocket as never }
    )).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });

    expect(createHmacMock).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("does not construct or send on a reconnect whose new permit is denied", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const controller = new AbortController();
    const authorizer = signedRequestAuthorizerForTests({ maxConsumes: 1 });
    const subscription = await subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      { authorizer, signal: controller.signal },
      {
        now: () => 1_000,
        random: () => 0,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        }
      }
    );

    sockets[0].emit("open");
    expect(sockets[0].sent).toHaveLength(1);
    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(authorizer.consumedCount()).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(1);
    controller.abort();
    expect(subscription.connected()).toBe(false);
  });

  it("requires both an authorizer and AbortSignal before any private side effect", async () => {
    const createSocket = vi.fn();
    const fetchMock = vi.fn();

    await expect(subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      { onSnapshot: vi.fn(), onConnection: vi.fn() },
      {} as never,
      { fetch: fetchMock as typeof fetch, createSocket: createSocket as never }
    )).rejects.toThrow(/requires an authorizer and AbortSignal/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });
});
