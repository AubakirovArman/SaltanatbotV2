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
  it("assigns an idempotent client id before sending an order that omitted one", async () => {
    const h = harness();
    const withoutIdentity = { ...order, clientId: undefined };
    let sentClientId: string | undefined;

    await h.lifecycle.execute(context, withoutIdentity, async () => {
      sentClientId = withoutIdentity.clientId;
      return { ok: true, message: "accepted", fills: [] };
    });

    expect(sentClientId).toMatch(/^event-/);
    expect(h.records[0]).toMatchObject({ id: sentClientId, clientId: sentClientId });
  });

  it("persists intent before exchange I/O and then accepted result and fills", async () => {
    const h = harness();
    const send = vi.fn(async () => {
      h.calls.push("exchange");
      return accepted;
    });

    await expect(h.lifecycle.execute(context, order, send)).resolves.toBe(accepted);

    expect(h.calls).toEqual(["order:intent", "event:intent", "exchange", "order:filled", "event:result", "event:fill"]);
    expect(h.records.map((record) => record.status)).toEqual(["intent", "filled"]);
    expect(h.records.at(-1)).toMatchObject({ filledQty: 1, avgFillPrice: 100 });
    expect(h.events.at(-2)?.data).toMatchObject({ status: "filled", ok: true });
  });

  it("persists a known exchange rejection as rejected", async () => {
    const h = harness();
    const rejected: ExecResult = { ok: false, message: "insufficient balance", fills: [] };

    await expect(h.lifecycle.execute(context, order, async () => rejected)).resolves.toBe(rejected);

    expect(h.records.at(-1)).toMatchObject({ status: "rejected", message: "insufficient balance" });
    expect(h.events.at(-1)?.data).toMatchObject({ status: "rejected", ok: false });
  });

  it("records the complete protected-entry state machine", () => {
    const h = harness();
    const protectedOrder = { ...order, action: "open", market: "futures", stop: { basis: "price", value: 95 } } as const;
    const record = h.lifecycle.begin({ ...context, market: "futures" }, protectedOrder);
    const next = h.lifecycle.complete(record, {
      ok: true, message: "protected", fills: [],
      protection: { requested: true, confirmed: true, entryOrderId: "entry", stopOrderIds: ["stop"], verification: "order_ids" },
    });

    expect(record.executionStatus).toBe("entry_submitted");
    expect(next.executionStatus).toBe("open_protected");
    expect(h.events.at(-1)?.data).toMatchObject({
      lifecycleTransitions: ["entry_submitted", "entry_confirmed", "protection_submitted", "protection_confirmed", "open_protected"],
    });
  });

  it("marks rejected protection as unprotected and erroneous", () => {
    const h = harness();
    const record = h.lifecycle.begin({ ...context, market: "futures" }, { ...order, action: "open" });
    const next = h.lifecycle.complete(record, {
      ok: false, message: "entry closed", fills: [],
      protection: { requested: true, confirmed: false, message: "stop rejected" },
    });

    expect(next.executionStatus).toBe("error");
    expect(h.events.at(-1)?.data).toMatchObject({ lifecycleTransitions: expect.arrayContaining(["open_unprotected", "error"]) });
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

  it("applies polling snapshots idempotently", () => {
    const h = harness();
    const record = h.lifecycle.complete(h.lifecycle.begin(context, order), { ok: true, message: "accepted", fills: [] });
    const snapshot = { id: "exchange-1", clientId: order.clientId, status: "partially_filled", qty: 1, filledQty: 0.5, avgFillPrice: 100, updatedAt: 150 } as const;

    const next = h.lifecycle.applySnapshot(record, snapshot);
    const unchanged = h.lifecycle.applySnapshot(next, snapshot);

    expect(next).toMatchObject({ status: "partially_filled", filledQty: 0.5, avgFillPrice: 100 });
    expect(unchanged).toBe(next);
    expect(h.events.filter((event) => event.type === "update")).toHaveLength(1);
  });

  it("does not regress partial or terminal state on out-of-order exchange snapshots", () => {
    const h = harness();
    const partial = { ...h.lifecycle.complete(h.lifecycle.begin(context, order), { ok: true, message: "partial", fills: [{ ...accepted.fills[0], qty: 0.5 }] }), exchangeOrderId: "exchange-1" };
    const acceptedReplay = { id: "exchange-1", clientId: order.clientId, status: "accepted", qty: 1, filledQty: 0, updatedAt: 200 } as const;
    expect(h.lifecycle.applySnapshot(partial, acceptedReplay)).toBe(partial);

    const filled = h.lifecycle.applySnapshot(partial, { ...acceptedReplay, status: "filled", filledQty: 1, updatedAt: 201 });
    expect(filled.status).toBe("filled");
    expect(h.lifecycle.applySnapshot(filled, { ...acceptedReplay, status: "partially_filled", filledQty: 0.8, updatedAt: 202 })).toBe(filled);
  });
});
