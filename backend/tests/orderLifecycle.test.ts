import { describe, expect, it, vi } from "vitest";
import { OrderLifecycle, type OrderLifecycleWriter } from "../src/trading/orderLifecycle.js";
import type { ExecOrder, ExecResult, OrderEventRecord, OrderJournalRecord } from "../src/trading/types.js";

const context = { botId: "bot-1", exchange: "paper", market: "spot" } as const;
const order: ExecOrder = {
  action: "neworder",
  market: "spot",
  symbol: "BTCUSDT",
  side: "buy",
  type: "market",
  qty: 1,
  clientId: "client-1",
  reason: "test"
};

function harness() {
  const calls: string[] = [];
  const records: OrderJournalRecord[] = [];
  const events: OrderEventRecord[] = [];
  let id = 0;
  let time = 100;
  const writer: OrderLifecycleWriter = {
    upsertOrder(record) {
      calls.push(`order:${record.status}`);
      records.push(structuredClone(record));
    },
    insertEvent(event) {
      calls.push(`event:${event.type}`);
      events.push(structuredClone(event));
    },
    listEvents(orderId) {
      return events.filter((event) => event.orderId === orderId).map((event) => structuredClone(event));
    }
  };
  const lifecycle = new OrderLifecycle(writer, {
    now: () => time++,
    createId: () => `event-${++id}`
  });
  return { lifecycle, calls, records, events };
}

const accepted: ExecResult = {
  ok: true,
  message: "filled",
  fills: [
    {
      id: "fill-1",
      botId: "bot-1",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 1,
      price: 100,
      fee: 0.1,
      realizedPnl: 0,
      kind: "open",
      reason: "test",
      ts: 123
    }
  ]
};

describe("durable order lifecycle", () => {
  it("persists intent before exchange I/O and then accepted result and fills", async () => {
    const h = harness();
    const send = vi.fn(async () => {
      h.calls.push("exchange");
      return accepted;
    });

    await expect(h.lifecycle.execute(context, order, send)).resolves.toBe(accepted);

    expect(h.calls).toEqual(["order:intent", "event:intent", "exchange", "order:filled", "event:result", "event:fill"]);
    expect(h.records.map((record) => record.status)).toEqual(["intent", "filled"]);
    expect(h.events.at(-2)?.data).toMatchObject({ status: "filled", ok: true });
  });

  it("persists a known exchange rejection as rejected", async () => {
    const h = harness();
    const rejected: ExecResult = { ok: false, message: "insufficient balance", fills: [] };

    await expect(h.lifecycle.execute(context, order, async () => rejected)).resolves.toBe(rejected);

    expect(h.records.at(-1)).toMatchObject({ status: "rejected", message: "insufficient balance" });
    expect(h.events.at(-1)?.data).toMatchObject({ status: "rejected", ok: false });
  });

  it("distinguishes partial fills and successful command outcomes", () => {
    const partial = harness();
    const partialResult: ExecResult = { ...accepted, fills: [{ ...accepted.fills[0], qty: 0.4 }] };
    expect(partial.lifecycle.complete(partial.lifecycle.begin(context, order), partialResult).status).toBe("partially_filled");

    for (const [action, expected] of [["cancel", "cancelled"], ["replace", "replaced"]] as const) {
      const h = harness();
      const command = { ...order, action };
      expect(h.lifecycle.complete(h.lifecycle.begin(context, command), { ok: true, message: "done", fills: [] }).status).toBe(expected);
    }
  });

  it("persists a thrown transport result as unknown and rethrows it", async () => {
    const h = harness();
    const timeout = new Error("request timed out after send");

    await expect(h.lifecycle.execute(context, order, async () => { throw timeout; })).rejects.toBe(timeout);

    expect(h.records.map((record) => record.status)).toEqual(["intent", "unknown"]);
    expect(h.records.at(-1)).toMatchObject({ message: timeout.message });
    expect(h.events.at(-1)?.data).toEqual({ status: "unknown", ok: false, message: timeout.message });
  });

  it("does not contact the exchange when durable intent persistence fails", async () => {
    const send = vi.fn(async () => accepted);
    const lifecycle = new OrderLifecycle({
      upsertOrder() {
        throw new Error("database unavailable");
      },
      insertEvent() {}
    });

    await expect(lifecycle.execute(context, order, send)).rejects.toThrow("database unavailable");
    expect(send).not.toHaveBeenCalled();
  });

  it("persists a restart reconciliation decision as an auditable event", () => {
    const h = harness();
    const record = h.lifecycle.begin(context, order);

    const next = h.lifecycle.reconcile(record, "accepted", "matched on exchange", "exchange-1");

    expect(next).toMatchObject({ status: "accepted", exchangeOrderId: "exchange-1" });
    expect(h.events.at(-1)).toMatchObject({
      type: "reconcile",
      data: { status: "accepted", message: "matched on exchange", exchangeOrderId: "exchange-1" }
    });
  });

  it("advances a resting order when its asynchronous fill arrives", () => {
    const h = harness();
    const record = h.lifecycle.complete(h.lifecycle.begin(context, order), {
      ok: true,
      message: "resting",
      fills: [],
      pendingOrder: { id: "exchange-resting-1", clientId: order.clientId, symbol: order.symbol, side: "buy", type: "limit", qty: 1, price: 99, reduceOnly: false, tif: "GTC", createdAt: 1 }
    });

    const next = h.lifecycle.recordFill(record, { ...accepted.fills[0], orderId: "exchange-resting-1" });

    expect(record).toMatchObject({ status: "accepted", exchangeOrderId: "exchange-resting-1" });
    expect(next.status).toBe("filled");
    expect(h.events.at(-1)).toMatchObject({ type: "fill", data: { orderId: "exchange-resting-1" } });
  });

  it("uses cumulative asynchronous fills to reach the terminal filled state", () => {
    const h = harness();
    const record = h.lifecycle.complete(h.lifecycle.begin(context, order), { ok: true, message: "resting", fills: [] });
    const first = h.lifecycle.recordFill(record, { ...accepted.fills[0], qty: 0.4, orderId: "exchange-1" });
    const second = h.lifecycle.recordFill(first, { ...accepted.fills[0], id: "fill-2", qty: 0.6, orderId: "exchange-1" });

    expect(first.status).toBe("partially_filled");
    expect(second.status).toBe("filled");
  });
});
