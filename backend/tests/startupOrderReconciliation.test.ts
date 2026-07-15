import { describe, expect, it, vi } from "vitest";
import { OrderLifecycle } from "../src/trading/orderLifecycle.js";
import { reconcileStartupOrders } from "../src/trading/startupOrderReconciliation.js";
import type { ExchangeAdapter, OrderEventRecord, OrderJournalRecord, PendingOrder } from "../src/trading/types.js";

function record(id: string, status: OrderJournalRecord["status"]): OrderJournalRecord {
  return {
    id,
    botId: "bot",
    exchange: "bybit",
    market: "futures",
    symbol: "BTCUSDT",
    action: "open",
    side: "buy",
    type: "limit",
    qty: 1,
    reason: "test",
    clientId: `client-${id}`,
    exchangeOrderId: status === "intent" ? undefined : `venue-${id}`,
    status,
    filledQty: status === "partially_filled" ? 0.4 : 0,
    ts: 1,
    updatedAt: Number(id.replace(/\D/g, "")) || 1
  };
}

function openOrder(source: OrderJournalRecord): PendingOrder {
  return {
    id: source.exchangeOrderId ?? `venue-${source.id}`,
    clientId: source.clientId,
    symbol: source.symbol,
    side: source.side ?? "buy",
    type: source.type,
    qty: source.qty ?? 1,
    reduceOnly: false,
    tif: "GTC",
    createdAt: 1
  };
}

function harness() {
  const records: OrderJournalRecord[] = [];
  const events: OrderEventRecord[] = [];
  let nextId = 0;
  const lifecycle = new OrderLifecycle({
    upsertOrder: (value) => records.push(structuredClone(value)),
    insertEvent: (value) => events.push(structuredClone(value))
  }, { now: () => 100, createId: () => `event-${++nextId}` });
  return { lifecycle, records, events };
}

describe("startup order reconciliation", () => {
  it("updates aggregate terminal state but keeps fills unresolved without execution accounting", async () => {
    const h = harness();
    const accepted = record("1", "accepted");
    const partial = record("2", "partially_filled");
    const adapter = {
      orderStatus: vi.fn(async (_symbol: string, identity: { orderId?: string }) => ({
        id: identity.orderId ?? "",
        clientId: identity.orderId === "venue-1" ? accepted.clientId : partial.clientId,
        status: identity.orderId === "venue-1" ? "filled" : "cancelled",
        qty: 1,
        filledQty: identity.orderId === "venue-1" ? 1 : 0.4,
        avgFillPrice: 101,
        updatedAt: 50
      } as const))
    } as Pick<ExchangeAdapter, "orderStatus">;

    const result = await reconcileStartupOrders([partial, accepted], [], adapter, h.lifecycle);

    expect(result).toMatchObject({ checked: 2, resolved: 0, updated: 2 });
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved.map((issue) => issue.message).join(" ")).toMatch(/execution evidence/);
    expect(h.records.map((value) => value.status)).toEqual(["filled", "cancelled"]);
    expect(adapter.orderStatus).toHaveBeenNthCalledWith(1, "BTCUSDT", expect.objectContaining({ orderId: "venue-1" }));
  });

  it("keeps a reduce-only close unresolved until its authenticated fill is accounted", async () => {
    const h = harness();
    const close = {
      ...record("20", "accepted"),
      action: "close" as const,
      side: "sell" as const,
      reduceOnly: true
    };
    const adapter = {
      orderStatus: vi.fn(async () => ({
        id: close.exchangeOrderId ?? "",
        clientId: close.clientId,
        status: "filled" as const,
        qty: 1,
        filledQty: 1,
        avgFillPrice: 100,
        updatedAt: 50
      }))
    };

    const result = await reconcileStartupOrders([close], [], adapter, h.lifecycle);

    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].message).toMatch(/execution evidence/i);
    expect(h.records.at(-1)).toMatchObject({ action: "close", status: "filled", filledQty: 1 });
  });

  it("falls back to open orders and preserves a known partial fill", async () => {
    const h = harness();
    const partial = { ...record("3", "partially_filled"), exchangeOrderId: undefined };
    const adapter = { orderStatus: vi.fn(async () => { throw new Error("temporary timeout"); }) };

    const result = await reconcileStartupOrders([partial], [openOrder(partial)], adapter, h.lifecycle);

    expect(result.unresolved).toEqual([]);
    expect(h.records.at(-1)).toMatchObject({ status: "partially_filled", exchangeOrderId: "venue-3", filledQty: 0.4 });
    expect(h.events.at(-1)).toMatchObject({ type: "reconcile", data: { status: "partially_filled" } });
  });

  it("marks crash-left intent unknown and reports every unproven state", async () => {
    const h = harness();
    const intent = record("4", "intent");
    const accepted = record("5", "accepted");
    const adapter = { orderStatus: vi.fn(async () => null) };

    const result = await reconcileStartupOrders([intent, accepted], [], adapter, h.lifecycle);

    expect(result.unresolved.map((issue) => issue.record.status)).toEqual(["intent", "accepted"]);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ status: "unknown", message: expect.stringMatching(/operator review/i) });
  });

  it("skips fully accounted terminal rows and isolates a signed-query failure", async () => {
    const h = harness();
    const failed = record("6", "unknown");
    const adapter = { orderStatus: vi.fn(async () => { throw new Error("rate limited"); }) };

    const result = await reconcileStartupOrders([
      { ...record("7", "filled"), filledQty: 1, accountedFilledQty: 1 },
      failed
    ], [], adapter, h.lifecycle);

    expect(result.checked).toBe(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].message).toMatch(/rate limited/i);
    expect(adapter.orderStatus).toHaveBeenCalledTimes(1);
  });

  it("requires terminal proof for crash-left cancel and replace commands", async () => {
    const h = harness();
    const cancel = { ...record("10", "intent"), action: "cancel" as const, exchangeOrderId: "venue-target" };
    const replace = { ...record("11", "unknown"), action: "replace" as const };
    const adapter = {
      orderStatus: vi.fn(async (_symbol: string, identity: { orderId?: string; clientId?: string }) => ({
        id: identity.orderId ?? "venue-replacement",
        clientId: identity.clientId,
        status: "accepted" as const,
        qty: 1,
        filledQty: 0,
        updatedAt: 50
      }))
    };

    const result = await reconcileStartupOrders([cancel, replace], [openOrder(cancel), openOrder(replace)], adapter, h.lifecycle);

    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved.map((issue) => issue.message).join(" ")).toMatch(/does not prove (cancel|replace)/i);
  });

  it("accepts a terminal venue result as proof that cancellation completed", async () => {
    const h = harness();
    const cancel = { ...record("12", "unknown"), action: "cancel" as const };
    const adapter = {
      orderStatus: vi.fn(async () => ({
        id: cancel.exchangeOrderId ?? "",
        clientId: cancel.clientId,
        status: "cancelled" as const,
        qty: 1,
        filledQty: 0,
        updatedAt: 50
      }))
    };

    const result = await reconcileStartupOrders([cancel], [], adapter, h.lifecycle);

    expect(result).toMatchObject({ resolved: 1, updated: 1, unresolved: [] });
    expect(h.records.at(-1)?.status).toBe("cancelled");
  });

  it("queries a restart batch sequentially to avoid signed API bursts", async () => {
    const h = harness();
    let active = 0;
    let peak = 0;
    const adapter = {
      orderStatus: async (_symbol: string, identity: { orderId?: string; clientId?: string }) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          id: identity.orderId ?? "venue",
          clientId: identity.clientId,
          status: "accepted" as const,
          qty: 1,
          filledQty: 0,
          updatedAt: 50
        };
      }
    };

    const result = await reconcileStartupOrders([record("9", "accepted"), record("8", "accepted")], [], adapter, h.lifecycle);

    expect(result.resolved).toBe(2);
    expect(peak).toBe(1);
  });
});
