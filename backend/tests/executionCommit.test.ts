import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  orders: new Map<string, unknown>(),
  events: [] as unknown[],
  fills: new Set<string>(),
  settings: new Map<string, unknown>()
}));

vi.mock("../src/trading/store.js", () => {
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    upsertOrderJournal: (order: { id: string }) => state.orders.set(order.id, clone(order)),
    getOrderJournal: (id: string) => clone(state.orders.get(id)),
    insertOrderEvent: (event: unknown) => state.events.push(clone(event)),
    listOrderEvents: (orderId: string) => state.events
      .filter((event) => (event as { orderId?: string }).orderId === orderId)
      .map((event) => clone(event)),
    listRiskOrderJournal: () => [],
    listExecutionReconciliationJournal: () => [],
    withStoreTransaction: <T>(operation: () => T) => operation(),
    insertFill: (fill: { id: string }) => {
      if (state.fills.has(fill.id)) return false;
      state.fills.add(fill.id);
      return true;
    },
    getSetting: (key: string) => clone(state.settings.get(key)),
    setSetting: (key: string, value: unknown) => state.settings.set(key, clone(value))
  };
});

import { commitExecutionFill } from "../src/trading/executionCommit.js";
import { getFuturesExposure } from "../src/trading/futuresExposure.js";
import { orderLifecycle } from "../src/trading/orderLifecycle.js";
import { getSpotInventory } from "../src/trading/spotInventory.js";
import type { ExecOrder, FillRecord } from "../src/trading/types.js";

beforeEach(() => {
  state.orders.clear();
  state.events.length = 0;
  state.fills.clear();
  state.settings.clear();
});

const order = (market: "spot" | "futures"): ExecOrder => ({
  action: "open", market, symbol: "BTCUSDT", side: "buy", type: "market", qty: 1,
  clientId: `client-${market}`, reason: "test"
});

const fill = (id: string, qty: number, market: "spot" | "futures"): FillRecord => ({
  id, botId: "bot", symbol: "BTCUSDT", side: "buy", qty, price: 100, fee: 0,
  realizedPnl: 0, kind: "open", reason: "test", orderId: `venue-${market}`, clientId: `client-${market}`, ts: 10
});

describe("atomic execution accounting boundary", () => {
  it("keeps order-filled reserved until split executions update spot inventory", () => {
    const intent = orderLifecycle.begin({ botId: "bot", exchange: "bybit", market: "spot" }, order("spot"));
    const accepted = orderLifecycle.complete(intent, { ok: true, message: "accepted", fills: [] });
    const venueFilled = orderLifecycle.applySnapshot(accepted, {
      id: "venue-spot", clientId: "client-spot", status: "filled", qty: 1, filledQty: 1, updatedAt: 2
    });

    const first = commitExecutionFill(venueFilled, fill("bybit:fill-1", 0.4, "spot"));
    const replay = commitExecutionFill(first.record, fill("bybit:fill-1", 0.4, "spot"));
    const second = commitExecutionFill(first.record, fill("bybit:fill-2", 0.6, "spot"));

    expect(first).toMatchObject({ inserted: true, record: { status: "filled", accountedFilledQty: 0.4 } });
    expect(replay).toMatchObject({ inserted: false, alreadyAccounted: true, record: { accountedFilledQty: 0.4 } });
    expect(second.record).toMatchObject({ status: "filled", accountedFilledQty: 1 });
    expect(getSpotInventory("bot", "BTCUSDT")?.remainingQty).toBe(1);
    expect(state.events.filter((event) => (event as { type?: string }).type === "fill")).toHaveLength(2);
  });

  it("rejects a duplicate execution id whose payload is not the already-accounted fill", () => {
    const intent = orderLifecycle.begin({ botId: "bot", exchange: "bybit", market: "futures" }, order("futures"));
    const accepted = orderLifecycle.complete(intent, { ok: true, message: "accepted", fills: [] });
    const committed = commitExecutionFill(accepted, fill("bybit:conflict", 0.5, "futures"));

    expect(() => commitExecutionFill(committed.record, { ...fill("bybit:conflict", 0.6, "futures"), price: 101 }))
      .toThrow(/duplicated without matching durable accounting/i);
    expect(getFuturesExposure("bot", "BTCUSDT")?.grossQty).toBe(0.5);
  });

  it("updates the futures shadow ledger at the same committed boundary", () => {
    const intent = orderLifecycle.begin({ botId: "bot", exchange: "bybit", market: "futures" }, order("futures"));
    const accepted = orderLifecycle.complete(intent, { ok: true, message: "accepted", fills: [] });
    const committed = commitExecutionFill(accepted, fill("bybit:futures-1", 0.5, "futures"));

    expect(committed.record.accountedFilledQty).toBe(0.5);
    expect(getFuturesExposure("bot", "BTCUSDT")?.grossQty).toBe(0.5);
  });
});
