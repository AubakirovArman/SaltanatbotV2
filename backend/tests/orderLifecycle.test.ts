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

    expect(h.calls).toEqual(["order:intent", "event:intent", "exchange", "order:accepted", "event:result", "event:fill"]);
    expect(h.records.map((record) => record.status)).toEqual(["intent", "accepted"]);
    expect(h.events.at(-2)?.data).toMatchObject({ status: "accepted", ok: true });
  });

  it("persists a known exchange rejection as rejected", async () => {
    const h = harness();
    const rejected: ExecResult = { ok: false, message: "insufficient balance", fills: [] };

    await expect(h.lifecycle.execute(context, order, async () => rejected)).resolves.toBe(rejected);

    expect(h.records.at(-1)).toMatchObject({ status: "rejected", message: "insufficient balance" });
    expect(h.events.at(-1)?.data).toMatchObject({ status: "rejected", ok: false });
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
});
