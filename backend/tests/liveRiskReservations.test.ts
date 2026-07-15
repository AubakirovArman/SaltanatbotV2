import { describe, expect, it } from "vitest";
import {
  buildLiveRiskReservations,
  boundedLiveRiskJournal,
  isTerminalUnaccountedRisk,
  pendingMatchesReservation,
  requestedOpenOrderSlots,
  unaccountedRiskQuantity
} from "../src/trading/liveRiskReservations.js";
import type { ExecOrder, OrderJournalRecord, PendingOrder } from "../src/trading/types.js";

const identity = { exchange: "bybit" as const, market: "spot" as const, symbol: "BTCUSDT" };

function record(overrides: Partial<OrderJournalRecord> = {}): OrderJournalRecord {
  return {
    id: "order-1",
    botId: "bot-1",
    exchange: "bybit",
    market: "spot",
    symbol: "BTCUSDT",
    action: "open",
    side: "buy",
    type: "market",
    qty: 2,
    reason: "test",
    clientId: "client-1",
    status: "accepted",
    executionStatus: "entry_confirmed",
    reservedOpenOrderCount: 1,
    ts: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe("durable live-risk reservations", () => {
  it("reserves accepted, partial and filled-but-unaccounted quantities", () => {
    const reservations = buildLiveRiskReservations(identity, [
      record(),
      record({ id: "partial", qty: 3, status: "partially_filled", filledQty: 1, accountedFilledQty: 0.4 }),
      record({ id: "filled", qty: 4, status: "filled", filledQty: 4, accountedFilledQty: 1 })
    ]);
    expect(reservations.map((value) => [value.id, value.remainingQty, value.openOrderSlots])).toEqual([
      ["order-1", 2, 1],
      ["partial", 2.6, 1],
      ["filled", 3, 0]
    ]);
  });

  it("releases only execution quantity committed to accounting", () => {
    expect(buildLiveRiskReservations(identity, [
      record({ status: "filled", filledQty: 2, accountedFilledQty: 2 })
    ])).toEqual([]);
    expect(unaccountedRiskQuantity(record({ status: "filled", filledQty: 2, accountedFilledQty: 0 }))).toBe(2);
  });

  it("keeps a partial terminal fill reserved but releases its cancelled remainder", () => {
    const cancelled = record({ status: "cancelled", qty: 3, filledQty: 1, accountedFilledQty: 0.25 });
    expect(unaccountedRiskQuantity(cancelled)).toBe(0.75);
    expect(isTerminalUnaccountedRisk(cancelled)).toBe(true);
    expect(unaccountedRiskQuantity({ ...cancelled, accountedFilledQty: 1 })).toBe(0);
    expect(unaccountedRiskQuantity(record({ status: "rejected", filledQty: undefined }))).toBe(0);
  });

  it("holds legacy replace acknowledgements until their entry is accounted", () => {
    const replaced = record({ status: "replaced", type: "limit", price: 100 });
    expect(buildLiveRiskReservations(identity, [replaced])).toMatchObject([{ remainingQty: 2, openOrderSlots: 0 }]);
  });

  it("tracks spot sell reservations independently", () => {
    expect(buildLiveRiskReservations(identity, [record({ side: "sell", qty: 1.5 })])).toMatchObject([
      { side: "sell", remainingQty: 1.5 }
    ]);
  });

  it("fails closed on missing quantities, corrupt accounting and stale bindings", () => {
    expect(() => buildLiveRiskReservations(identity, [record({ qty: undefined })])).toThrow(/base quantity/);
    expect(() => buildLiveRiskReservations(identity, [record({ accountedFilledQty: 3 })])).toThrow(/greater/);
    expect(() => buildLiveRiskReservations(identity, [record({ symbol: "ETHUSDT" })])).toThrow(/different exchange, market, or symbol/);
  });

  it("matches venue identities and reserves every requested order slot", () => {
    const reservation = buildLiveRiskReservations(identity, [record()])[0]!;
    const pending: PendingOrder = {
      id: "venue-1", clientId: "client-1", symbol: "BTCUSDT", side: "buy", type: "limit",
      qty: 2, price: 100, reduceOnly: false, tif: "GTC", createdAt: 1
    };
    expect(pendingMatchesReservation(pending, reservation)).toBe(true);
    const order: ExecOrder = {
      action: "spreadentry", market: "futures", symbol: "BTCUSDT", side: "buy", type: "market", qty: 3,
      spreadCount: 3, stop: { basis: "percent", value: 2 }, takeProfits: [{ priceBasis: "percent", price: 4, qtyBasis: "percent", qty: 100 }], reason: "test"
    };
    expect(requestedOpenOrderSlots(order)).toBe(5);
  });

  it("fails closed when the unresolved journal exceeds its bounded read", () => {
    expect(() => boundedLiveRiskJournal(Array.from({ length: 1_001 }, (_, index) => record({ id: `order-${index}` })))).toThrow(/1000-order safety bound/);
  });
});
