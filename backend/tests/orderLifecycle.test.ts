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
  const current = new Map<string, OrderJournalRecord>();
  const events: OrderEventRecord[] = [];
  let id = 0;
  let time = 100;
  const orderKey = (botId: string, orderId: string) => `${botId}:${orderId}`;
  const writer: OrderLifecycleWriter = {
    upsertOrder(record) {
      calls.push(`order:${record.status}`);
      records.push(structuredClone(record));
      current.set(orderKey(record.botId, record.id), structuredClone(record));
    },
    insertEvent(event) {
      calls.push(`event:${event.type}`);
      events.push(structuredClone(event));
    },
    getOrder(botId, orderId) {
      const record = current.get(orderKey(botId, orderId));
      return record ? structuredClone(record) : undefined;
    },
    listEvents(botId, orderId) {
      return events
        .filter((event) => event.botId === botId && event.orderId === orderId)
        .map((event) => structuredClone(event));
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

  it("persists the adapter-normalized quantity without exceeding the original intent", async () => {
    const h = harness();
    const submitted = { ...order, qty: 1 };
    await h.lifecycle.execute(context, submitted, async () => {
      submitted.qty = 0.9;
      return { ok: true, message: "accepted", fills: [] };
    });
    expect(h.records.at(-1)?.qty).toBe(0.9);

    const unsafe = { ...order, clientId: "unsafe", qty: 1 };
    await expect(h.lifecycle.execute(context, unsafe, async () => {
      unsafe.qty = 1.1;
      return { ok: true, message: "accepted", fills: [] };
    })).rejects.toThrow(/exceeds its durable intent/);
    expect(h.records.at(-1)?.status).toBe("unknown");
  });

  it("persists intent and aggregate result before accounting commits individual fills", async () => {
    const h = harness();
    const send = vi.fn(async () => {
      h.calls.push("exchange");
      return accepted;
    });

    await expect(h.lifecycle.execute(context, order, send)).resolves.toBe(accepted);

    expect(h.calls).toEqual(["order:intent", "event:intent", "exchange", "order:filled", "event:result"]);
    expect(h.records.map((record) => record.status)).toEqual(["intent", "filled"]);
    expect(h.records.at(-1)).toMatchObject({ filledQty: 1, avgFillPrice: 100 });
    expect(h.events.at(-1)?.data).toMatchObject({ status: "filled", ok: true, fills: [{ id: "fill-1" }] });
  });

  it("does not overwrite a private-stream fill that commits before the REST response", async () => {
    const h = harness();
    let resolveSend: (result: ExecResult) => void = () => {};
    const execution = h.lifecycle.execute(context, { ...order }, () => new Promise<ExecResult>((resolve) => {
      resolveSend = resolve;
    }));
    await Promise.resolve();

    const intent = h.records[0];
    const venueFilled = h.lifecycle.applySnapshot(intent, {
      id: "exchange-race-1",
      clientId: order.clientId,
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 100,
      updatedAt: 150
    });
    h.lifecycle.recordFill(venueFilled, { ...accepted.fills[0], orderId: "exchange-race-1" });
    resolveSend({ ok: true, message: "REST accepted", fills: [] });
    await execution;

    expect(h.records.at(-1)).toMatchObject({
      status: "filled",
      exchangeOrderId: "exchange-race-1",
      filledQty: 1,
      accountedFilledQty: 1,
      avgFillPrice: 100,
      message: "Asynchronous fill 1 @ 100"
    });
    expect(h.events.map((event) => event.type)).toEqual(["intent", "update", "fill", "result"]);
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
    expect(record.reservedOpenOrderCount).toBe(2);
    expect(next).toMatchObject({ executionStatus: "open_protected", exchangeOrderId: "entry" });
    expect(h.events.at(-1)?.data).toMatchObject({
      lifecycleTransitions: ["entry_submitted", "entry_confirmed", "protection_submitted", "protection_confirmed", "open_protected"],
    });
  });

  it("writes deterministic protection child intents before live exchange I/O", async () => {
    const h = harness();
    const liveOrder: ExecOrder = {
      ...order,
      action: "open",
      market: "futures",
      clientId: "live-entry-1",
      stop: { basis: "price", value: 95 },
      takeProfits: [{ priceBasis: "price", price: 110, qtyBasis: "percent", qty: 100 }]
    };
    let identitiesAtSend: ExecOrder["protectionClientIds"];

    await h.lifecycle.execute(
      { botId: "bot-1", exchange: "binance", market: "futures" },
      liveOrder,
      async () => {
        identitiesAtSend = structuredClone(liveOrder.protectionClientIds);
        expect(h.records.filter((record) => record.status === "intent")).toHaveLength(4);
        liveOrder.qty = 0.9;
        return {
          ok: true,
          message: "protected",
          fills: [],
          protection: {
            requested: true,
            confirmed: true,
            entryOrderId: "venue-entry",
            stopOrderIds: ["venue-stop"],
            takeProfitOrderIds: ["venue-tp"],
            verification: "order_ids"
          }
        };
      }
    );

    expect(identitiesAtSend).toEqual({
      stop: "live-entry-1-sl",
      takeProfits: ["live-entry-1-tp1"],
      safetyClose: "live-entry-1-safety"
    });
    const latest = new Map(h.records.map((record) => [record.id, record]));
    expect(latest.get("live-entry-1-sl")).toMatchObject({ status: "accepted", exchangeOrderId: "venue-stop", qty: 0.9, reduceOnly: true });
    expect(latest.get("live-entry-1-tp1")).toMatchObject({ status: "accepted", exchangeOrderId: "venue-tp", qty: 0.9, reduceOnly: true });
    expect(latest.get("live-entry-1-safety")).toMatchObject({ status: "rejected", qty: 0.9, reduceOnly: true });
  });

  it("keeps unproven orphan protection and emergency close children fail-closed", async () => {
    const h = harness();
    const liveOrder: ExecOrder = {
      ...order,
      action: "open",
      market: "futures",
      clientId: "live-entry-2",
      stop: { basis: "price", value: 95 }
    };

    await h.lifecycle.execute(
      { botId: "bot-1", exchange: "binance", market: "futures" },
      liveOrder,
      async () => ({
        ok: true,
        message: "protection failed",
        fills: [],
        protection: {
          requested: true,
          confirmed: false,
          entryOrderId: "venue-entry",
          stopOrderIds: ["venue-stop"],
          orphanProtectionOrderIds: ["venue-stop"],
          safetyCloseAttempted: true,
          safetyCloseConfirmed: true,
          safetyCloseOrderId: "venue-safety",
          safetyCloseClientId: "live-entry-2-safety",
          verification: "order_ids"
        }
      })
    );

    const latest = new Map(h.records.map((record) => [record.id, record]));
    expect(latest.get("live-entry-2-sl")).toMatchObject({ status: "unknown", exchangeOrderId: "venue-stop" });
    expect(latest.get("live-entry-2-safety")).toMatchObject({ status: "accepted", exchangeOrderId: "venue-safety" });
  });

  it("retains Bybit position-level protection even when no child order ID is exposed", async () => {
    const h = harness();
    const liveOrder: ExecOrder = {
      ...order,
      action: "open",
      market: "futures",
      clientId: "bybit-entry-1",
      stop: { basis: "price", value: 95 }
    };

    await h.lifecycle.execute(
      { botId: "bot-1", exchange: "bybit", market: "futures" },
      liveOrder,
      async () => ({
        ok: true,
        message: "protected",
        fills: [],
        protection: { requested: true, confirmed: true, entryOrderId: "venue-entry", verification: "exchange_ack" }
      })
    );

    const latest = new Map(h.records.map((record) => [record.id, record]));
    expect(latest.get("bybit-entry-1-sl")).toMatchObject({
      status: "accepted",
      exchangeOrderId: undefined,
      message: expect.stringMatching(/without a correlatable child order ID/i)
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
    expect(second.accountedFilledQty).toBe(1);
  });

  it("preserves terminal venue state while accounting a late partial execution", () => {
    const h = harness();
    const cancelled = {
      ...h.lifecycle.complete(h.lifecycle.begin(context, order), { ok: true, message: "resting", fills: [] }),
      status: "cancelled" as const,
      filledQty: 0.4
    };
    const next = h.lifecycle.recordFill(cancelled, { ...accepted.fills[0], qty: 0.4, orderId: "exchange-1" });

    expect(next).toMatchObject({ status: "cancelled", filledQty: 0.4, accountedFilledQty: 0.4 });
    expect(() => h.lifecycle.recordFill(next, { ...accepted.fills[0], id: "overflow", qty: 0.7 })).toThrow(/exceeds requested quantity/);
  });

  it("handles order-filled before split execution events without releasing accounting early", () => {
    const h = harness();
    const acceptedRecord = h.lifecycle.complete(h.lifecycle.begin(context, order), { ok: true, message: "accepted", fills: [] });
    const venueFilled = h.lifecycle.applySnapshot(acceptedRecord, {
      id: "exchange-1", clientId: order.clientId, status: "filled", qty: 1, filledQty: 1, updatedAt: 200
    });
    const first = h.lifecycle.recordFill(venueFilled, { ...accepted.fills[0], qty: 0.4, orderId: "exchange-1" });
    const second = h.lifecycle.recordFill(first, { ...accepted.fills[0], id: "fill-2", qty: 0.6, orderId: "exchange-1" });

    expect(venueFilled.accountedFilledQty).toBeUndefined();
    expect(first).toMatchObject({ status: "filled", filledQty: 1, accountedFilledQty: 0.4 });
    expect(second).toMatchObject({ status: "filled", filledQty: 1, accountedFilledQty: 1 });
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
