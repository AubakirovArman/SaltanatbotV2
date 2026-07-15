import { describe, expect, it } from "vitest";
import { ingestExchangeOrderEvent } from "../src/trading/orderEventIngest.js";
import { OrderLifecycle } from "../src/trading/orderLifecycle.js";
import type { OrderEventRecord, OrderJournalRecord } from "../src/trading/types.js";

function record(status: OrderJournalRecord["status"] = "accepted"): OrderJournalRecord {
  return {
    id: "intent-1",
    botId: "bot-1",
    exchange: "binance",
    market: "futures",
    symbol: "BTCUSDT",
    action: "open",
    side: "buy",
    type: "limit",
    qty: 1,
    reason: "test",
    clientId: "client-1",
    status,
    filledQty: status === "partially_filled" ? 0.4 : 0,
    ts: 10,
    updatedAt: 20
  };
}

function harness() {
  const records: OrderJournalRecord[] = [];
  const events: OrderEventRecord[] = [];
  let id = 0;
  const lifecycle = new OrderLifecycle({
    upsertOrder: (next) => records.push(structuredClone(next)),
    insertEvent: (event) => events.push(structuredClone(event))
  }, { now: () => 100, createId: () => `event-${++id}` });
  return { lifecycle, records, events };
}

describe("exchange order event ingest", () => {
  it("matches a private event by client id and advances accepted to filled", () => {
    const h = harness();
    const result = ingestExchangeOrderEvent([record()], {
      id: "exchange-1",
      clientId: "client-1",
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 101,
      updatedAt: 90
    }, h.lifecycle);

    expect(result).toMatchObject({ kind: "updated", record: { status: "filled", exchangeOrderId: "exchange-1" } });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: "update", data: { status: "filled" } });
  });

  it("ignores reconnect replays and out-of-order regressions idempotently", () => {
    const h = harness();
    const partial = { ...record("partially_filled"), exchangeOrderId: "exchange-1" };
    const replay = ingestExchangeOrderEvent([partial], {
      id: "exchange-1",
      clientId: "client-1",
      status: "partially_filled",
      qty: 1,
      filledQty: 0.4,
      updatedAt: 20
    }, h.lifecycle);
    const regression = ingestExchangeOrderEvent([partial], {
      id: "exchange-1",
      clientId: "client-1",
      status: "accepted",
      qty: 1,
      filledQty: 0,
      updatedAt: 30
    }, h.lifecycle);

    expect(replay).toMatchObject({ kind: "ignored", reason: "duplicate" });
    expect(regression).toMatchObject({ kind: "ignored", reason: "invalid_transition" });
    expect(h.records).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("rejects conflicting venue identity and leaves unmatched events unclaimed", () => {
    const h = harness();
    const existing = { ...record(), exchangeOrderId: "exchange-original" };

    expect(ingestExchangeOrderEvent([existing], {
      id: "exchange-other",
      clientId: "client-1",
      status: "filled",
      qty: 1,
      filledQty: 1,
      updatedAt: 40
    }, h.lifecycle)).toMatchObject({ kind: "ignored", reason: "identity_conflict" });
    expect(ingestExchangeOrderEvent([existing], {
      id: "missing",
      clientId: "missing-client",
      status: "filled",
      qty: 1,
      filledQty: 1,
      updatedAt: 40
    }, h.lifecycle)).toEqual({ kind: "unmatched" });
    expect(h.records).toHaveLength(0);
  });

  it("rejects a conflicting client identity even when the venue order ID matches", () => {
    const h = harness();
    const existing = { ...record(), exchangeOrderId: "exchange-1" };
    const conflicting = {
      id: "exchange-1",
      clientId: "foreign-client",
      status: "filled" as const,
      qty: 1,
      filledQty: 1,
      avgFillPrice: 101,
      updatedAt: 40,
      execution: { id: "execution-1", qty: 1, price: 101, fee: 0, realizedPnl: 0, ts: 40 }
    };

    expect(ingestExchangeOrderEvent([existing], conflicting, h.lifecycle)).toMatchObject({
      kind: "ignored",
      reason: "identity_conflict",
      record: { clientId: "client-1", exchangeOrderId: "exchange-1" }
    });
    expect(ingestExchangeOrderEvent([existing], conflicting, h.lifecycle)).toMatchObject({ kind: "ignored", reason: "identity_conflict" });
    expect(h.records).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(existing.clientId).toBe("client-1");
  });

  it("rejects crossed and duplicated venue/client identity matches", () => {
    const h = harness();
    const venueRecord = { ...record(), id: "intent-a", exchangeOrderId: "exchange-1" };
    const clientRecord = { ...record(), id: "intent-b", clientId: "client-b", exchangeOrderId: "exchange-2" };
    const duplicateVenue = { ...record(), id: "intent-c", clientId: "client-c", exchangeOrderId: "exchange-1" };
    const snapshot = {
      id: "exchange-1",
      clientId: "client-b",
      status: "filled" as const,
      qty: 1,
      filledQty: 1,
      updatedAt: 40
    };

    expect(ingestExchangeOrderEvent([venueRecord, clientRecord], snapshot, h.lifecycle)).toMatchObject({ kind: "ignored", reason: "identity_conflict" });
    expect(ingestExchangeOrderEvent([venueRecord, duplicateVenue], { ...snapshot, clientId: undefined }, h.lifecycle)).toMatchObject({ kind: "ignored", reason: "identity_conflict" });
    expect(h.records).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
});
