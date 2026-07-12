import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBinanceAggregateTrade } from "../src/tradeflow/binance";
import { parseBybitPublicTrades } from "../src/tradeflow/bybit";
import { TradeFlowHub } from "../src/tradeflow/hub";
import type { TradeFlowConnectorCallbacks } from "../src/tradeflow/types";

afterEach(() => vi.useRealTimers());

describe("public trade flow", () => {
  it("maps exchange aggressor semantics without guessing from price movement", () => {
    expect(parseBinanceAggregateTrade({ e: "aggTrade", a: 7, p: "101.5", q: "2", T: 10, m: true })).toEqual({
      id: "7", price: 101.5, size: 2, side: "sell", exchangeTs: 10
    });
    expect(parseBinanceAggregateTrade({ e: "aggTrade", a: 8, p: "102", q: "3", T: 11, m: false })?.side).toBe("buy");
    expect(parseBybitPublicTrades({ topic: "publicTrade.BTCUSDT", data: [
      { i: "a", p: "100", v: "1.5", T: 12, S: "Buy" },
      { i: "b", p: "99", v: "2", T: 13, S: "Sell" }
    ] })).toEqual([
      { id: "a", price: 100, size: 1.5, side: "buy", exchangeTs: 12 },
      { id: "b", price: 99, size: 2, side: "sell", exchangeTs: 13 }
    ]);
  });

  it("rejects malformed and zero-sized public prints", () => {
    expect(parseBinanceAggregateTrade({ e: "aggTrade", a: 1, p: "100", q: "0", T: 1, m: false })).toBeUndefined();
    expect(parseBybitPublicTrades({ topic: "publicTrade.BTCUSDT", data: [{ i: "a", p: "100", v: "x", T: 1, S: "Buy" }] })).toBeUndefined();
  });

  it("shares one upstream and publishes bounded microbatches", () => {
    vi.useFakeTimers();
    let callbacks: TradeFlowConnectorCallbacks | undefined;
    let starts = 0;
    let closes = 0;
    const hub = new TradeFlowHub((_exchange, _symbol, next) => {
      starts += 1;
      callbacks = next;
      return { close: () => { closes += 1; } };
    }, 100, () => 50);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = hub.subscribe("binance", "BTCUSDT", (message) => first.push(message));
    const b = hub.subscribe("binance", "BTCUSDT", (message) => second.push(message));
    callbacks?.onTrades([trade("1"), trade("2")]);
    expect(starts).toBe(1);
    expect(first).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(first).toMatchObject([{ type: "trade_flow", trades: [{ id: "1" }, { id: "2" }] }]);
    expect(second).toEqual(first);
    a.close();
    expect(closes).toBe(0);
    b.close();
    expect(closes).toBe(1);
    expect(hub.activeFlows()).toBe(0);
  });

  it("fails closed at the shared upstream limit", () => {
    const hub = new TradeFlowHub(() => ({ close() {} }), 100, Date.now, 1);
    const first = hub.subscribe("binance", "BTCUSDT", () => undefined);
    expect(() => hub.subscribe("bybit", "ETHUSDT", () => undefined)).toThrow(/stream limit reached/);
    first.close();
  });
});

function trade(id: string) {
  return { id, price: 100, size: 1, side: "buy" as const, exchangeTs: 1 };
}
