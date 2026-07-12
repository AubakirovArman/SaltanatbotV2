import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderBookConnectorCallbacks } from "../src/orderbook/types";
import { parseBinancePartialDepth } from "../src/orderbook/binance";
import { parseBybitDepth } from "../src/orderbook/bybit";
import { OrderBookHub } from "../src/orderbook/hub";
import { LocalOrderBook } from "../src/orderbook/localBook";

afterEach(() => vi.useRealTimers());

describe("public order book", () => {
  it("replaces, updates, removes and sorts local levels", () => {
    const book = new LocalOrderBook();
    book.reset([[100, 2], [99, 3]], [[101, 4], [102, 5]]);
    book.apply([[100, 0], [98, 7]], [[101, 6]]);
    expect(book.snapshot()).toEqual({ bids: [[99, 3], [98, 7]], asks: [[101, 6], [102, 5]] });
  });

  it("parses bounded Binance partial snapshots and Bybit snapshot/delta events", () => {
    expect(parseBinancePartialDepth({ lastUpdateId: 10, bids: [["100", "2"], ["99", "0"]], asks: [["101", "3"]] })).toEqual({
      lastUpdateId: 10, bids: [[100, 2]], asks: [[101, 3]]
    });
    expect(parseBybitDepth({ type: "delta", ts: 5, data: { u: 6, seq: 7, b: [["100", "0"]], a: [["101", "4"]] } })).toMatchObject({
      type: "delta", updateId: 6, sequence: 7, bids: [[100, 0]], asks: [[101, 4]]
    });
    expect(parseBinancePartialDepth({ lastUpdateId: 10, bids: [["bad", "2"]], asks: [] })).toBeUndefined();
  });

  it("shares one upstream, publishes only the latest throttled snapshot and closes after the last listener", () => {
    vi.useFakeTimers();
    let callbacks: OrderBookConnectorCallbacks | undefined;
    let starts = 0;
    let closes = 0;
    let now = 0;
    const hub = new OrderBookHub((_exchange, _symbol, next) => {
      starts += 1;
      callbacks = next;
      return { close: () => { closes += 1; } };
    }, 250, () => now);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = hub.subscribe("binance", "BTCUSDT", (message) => first.push(message));
    const b = hub.subscribe("binance", "BTCUSDT", (message) => second.push(message));
    expect(starts).toBe(1);
    callbacks?.onSnapshot(snapshot(1));
    now = 100;
    callbacks?.onSnapshot(snapshot(2));
    now = 250;
    vi.advanceTimersByTime(250);
    expect(first).toMatchObject([{ sequence: 2 }]);
    expect(second).toMatchObject([{ sequence: 2 }]);
    a.close();
    expect(closes).toBe(0);
    b.close();
    expect(closes).toBe(1);
    expect(hub.activeBooks()).toBe(0);
  });

  it("fails closed when the global upstream-book limit is reached", () => {
    const hub = new OrderBookHub(() => ({ close() {} }), 0, Date.now, 1);
    const first = hub.subscribe("binance", "BTCUSDT", () => undefined);
    expect(() => hub.subscribe("binance", "ETHUSDT", () => undefined)).toThrow(/stream limit reached/);
    first.close();
  });
});

function snapshot(sequence: number) {
  return {
    type: "orderbook" as const,
    symbol: "BTCUSDT",
    exchange: "binance" as const,
    bids: [[100, 2]] as [[number, number]],
    asks: [[101, 3]] as [[number, number]],
    sequence,
    exchangeTs: sequence,
    ts: sequence
  };
}
