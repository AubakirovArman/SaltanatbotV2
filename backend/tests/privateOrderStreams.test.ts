import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  parseBinanceOrderUpdate,
  parseBybitExecutionUpdates,
  parseBybitOrderUpdates,
  subscribeBinanceOrders,
  subscribeBybitOrders
} from "../src/trading/exchange/privateOrderStreams.js";

class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 1;
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

afterEach(() => vi.useRealTimers());

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
        t: 9001, l: "0.25", L: "102", n: "0.0102", N: "USDT", rp: "1.5", S: "SELL", T: 499
      }
    })).toMatchObject({
      execution: {
        id: "binance:9001", qty: 0.25, price: 102, fee: 0.0102, feeAsset: "USDT",
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
  });
});

describe("Bybit authenticated order stream", () => {
  it("authenticates, subscribes, heartbeats and emits normalized snapshots", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const snapshots: unknown[] = [];
    const connections: Array<[boolean, string]> = [];
    const now = 1_000;
    const subscription = await subscribeBybitOrders(
      { apiKey: "key", apiSecret: "secret" },
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onConnection: (connected, message) => connections.push([connected, message])
      },
      { now: () => now, random: () => 0, createSocket: () => socket as unknown as WebSocket }
    );

    socket.emit("open");
    const auth = JSON.parse(socket.sent[0]) as { op: string; args: [string, number, string] };
    const expires = now + 10_000;
    expect(auth).toEqual({
      op: "auth",
      args: ["key", expires, createHmac("sha256", "secret").update(`GET/realtime${expires}`).digest("hex")]
    });

    socket.emit("message", Buffer.from(JSON.stringify({ op: "auth", success: true })));
    expect(JSON.parse(socket.sent[1])).toEqual({ op: "subscribe", args: ["order", "execution"] });
    socket.emit("message", Buffer.from(JSON.stringify({ op: "subscribe", success: true })));
    expect(subscription.connected()).toBe(true);
    expect(connections.at(-1)?.[0]).toBe(true);

    socket.emit("message", Buffer.from(JSON.stringify({
      topic: "order",
      creationTime: 10,
      data: [{ orderId: "v1", orderLinkId: "c1", orderStatus: "Cancelled", qty: "2", cumExecQty: "1", avgPrice: "100", updatedTime: "9" }]
    })));
    expect(snapshots).toMatchObject([{ id: "v1", clientId: "c1", status: "cancelled", filledQty: 1 }]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ op: "ping" });
    subscription.close();
  });
});
