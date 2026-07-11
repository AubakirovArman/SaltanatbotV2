import { describe, expect, it } from "vitest";
import { fillFromExchangeExecution, hasRecordedExecution } from "../src/trading/executionAccounting.js";
import type { ExchangeOrderSnapshot, OrderEventRecord, OrderJournalRecord } from "../src/trading/types.js";

const record: OrderJournalRecord = {
  id: "journal-1", botId: "bot-1", exchange: "binance", market: "futures", symbol: "BTCUSDT",
  action: "close", side: "sell", type: "market", qty: 1, reduceOnly: true, reason: "signal:exit",
  clientId: "client-1", status: "partially_filled", ts: 1, updatedAt: 2
};

const snapshot: ExchangeOrderSnapshot = {
  id: "venue-1", clientId: "client-1", status: "partially_filled", qty: 1, filledQty: 0.4,
  updatedAt: 3,
  execution: {
    id: "binance:trade-1", qty: 0.4, price: 101, fee: 0.02, feeAsset: "BNB",
    realizedPnl: 3.5, side: "sell", ts: 3
  }
};

describe("private execution accounting", () => {
  it("preserves venue fee asset and realized PnL in a durable fill", () => {
    expect(fillFromExchangeExecution(record, snapshot)).toEqual({
      id: "binance:trade-1", botId: "bot-1", symbol: "BTCUSDT", side: "sell", qty: 0.4,
      price: 101, fee: 0.02, feeAsset: "BNB", realizedPnl: 3.5, kind: "close",
      reason: "signal:exit", orderId: "venue-1", clientId: "client-1", ts: 3
    });
  });

  it("deduplicates replayed execution IDs after reconnect", () => {
    const event: OrderEventRecord = {
      id: "event-1", orderId: record.id, botId: record.botId, type: "fill",
      data: fillFromExchangeExecution(record, snapshot), ts: 3
    };
    expect(hasRecordedExecution([event], "binance:trade-1")).toBe(true);
    expect(hasRecordedExecution([event], "binance:trade-2")).toBe(false);
  });
});
