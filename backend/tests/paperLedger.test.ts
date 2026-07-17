import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAdapter, type PaperExecutionQuote, type VerifiedPaperFundingSettlement } from "../src/trading/exchange/paper.js";
import { appendPaperEvents, replayPaperLedger } from "../src/trading/paperLedger.js";
import { appendPaperLedgerEventsTo, listPaperLedgerEventsFrom } from "../src/trading/paperLedgerStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { ExecOrder, Side } from "../src/trading/types.js";

const databases: DatabaseSync[] = [];

function order(overrides: Partial<ExecOrder>): ExecOrder {
  return {
    action: "neworder",
    market: "futures",
    symbol: "BTCUSDT",
    type: "market",
    reason: "ledger-test",
    ...overrides
  };
}

function deterministicAdapter(overrides: {
  idPrefix?: string;
  ledgerEpoch?: number;
  feePct?: number;
  getExecutionQuote?: (symbol: string, side: Side, qty: number) => PaperExecutionQuote | undefined;
} = {}) {
  let id = 0;
  return new PaperAdapter({
    botId: "paper-ledger-test",
    ledgerEpoch: overrides.ledgerEpoch,
    market: "futures",
    startBalance: 10_000,
    feePct: overrides.feePct ?? 0,
    slipPct: 0,
    getPrice: () => 100,
    getExecutionQuote: overrides.getExecutionQuote,
    now: () => 1_720_000_000_000 + id,
    createId: () => `${overrides.idPrefix ?? "event"}-${++id}`
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("append-only paper ledger", () => {
  it("recovers balance, position, orders and settings deterministically", async () => {
    const adapter = deterministicAdapter({ feePct: 0.1 });
    await adapter.execute(order({ action: "set", setValue: "LEVERAGE", leverage: 3 }));
    await adapter.execute(order({ action: "set", setValue: "ISOLATEDMARGIN", isolated: true }));
    await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    await adapter.execute(order({ side: "sell", type: "limit", qty: 1, price: 110, reduceOnly: true }));

    const events = adapter.getLedgerEvents();
    const recovered = new PaperAdapter({
      botId: "paper-ledger-test",
      market: "futures",
      startBalance: 1,
      feePct: 0.1,
      slipPct: 0,
      getPrice: () => 100,
      initialEvents: [...events].reverse()
    });

    expect(recovered.getState()).toEqual(adapter.getState());
    expect(recovered.getLedgerState()).toEqual(adapter.getLedgerState());
    expect(replayPaperLedger(events, "paper-ledger-test")).toEqual(adapter.getLedgerState());
  });

  it("reconstructs realized PnL and open/close commissions from separate cash and fee events", async () => {
    let quote: PaperExecutionQuote = { price: 100, availableQty: 2, source: "depth-snapshot", verified: true };
    const adapter = deterministicAdapter({ feePct: 0.1, getExecutionQuote: () => quote });
    await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    quote = { price: 110, availableQty: 1, source: "depth-snapshot", verified: true };
    await adapter.execute(order({ action: "close", side: "sell", qty: 1 }));

    const ledger = adapter.getLedgerState();
    expect(ledger.balance).toBeCloseTo(10_009.69, 9);
    expect(ledger.feesPaid).toBeCloseTo(0.31, 9);
    expect(ledger.position?.qty).toBe(1);
    expect(adapter.getLedgerEvents().map((event) => event.type)).toEqual(expect.arrayContaining(["fill", "fee", "cash", "position"]));

    const recovered = new PaperAdapter({
      botId: "paper-ledger-test",
      market: "futures",
      startBalance: 0,
      feePct: 0.1,
      slipPct: 0,
      getPrice: () => 110,
      initialEvents: adapter.getLedgerEvents()
    });
    expect(recovered.getState()).toEqual(adapter.getState());
  });

  it("treats an exact event redelivery as a no-op and rejects conflicts", () => {
    const adapter = deterministicAdapter();
    const events = adapter.getLedgerEvents();
    const repeated = appendPaperEvents(events, events, "paper-ledger-test");
    expect(repeated.events).toHaveLength(events.length);
    expect(repeated.state).toEqual(adapter.getLedgerState());

    const conflict = structuredClone(events[0]);
    conflict.ts += 1;
    expect(() => appendPaperEvents(events, [conflict], "paper-ledger-test")).toThrow(/Conflicting paper event id/);
  });

  it("rejects sequence gaps and accounting events that do not match their fill", async () => {
    let quote: PaperExecutionQuote = { price: 100, availableQty: 1, source: "depth-snapshot", verified: true };
    const adapter = deterministicAdapter({ feePct: 0.1, getExecutionQuote: () => quote });
    await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    quote = { price: 110, availableQty: 1, source: "depth-snapshot", verified: true };
    await adapter.execute(order({ action: "close", side: "sell", qty: 1 }));
    const events = adapter.getLedgerEvents();

    expect(() => replayPaperLedger(events.filter((event) => event.sequence !== 2), "paper-ledger-test")).toThrow(/gap/i);

    const forgedCash = structuredClone(events);
    const cash = forgedCash.find((event) => event.type === "cash");
    if (!cash || cash.type !== "cash") throw new Error("Cash fixture missing");
    cash.data.amount += 100;
    expect(() => replayPaperLedger(forgedCash, "paper-ledger-test")).toThrow(/cash does not match/i);

    const forgedFee = structuredClone(events);
    const fee = forgedFee.find((event) => event.type === "fee");
    if (!fee || fee.type !== "fee") throw new Error("Fee fixture missing");
    fee.data.amount += 1;
    expect(() => replayPaperLedger(forgedFee, "paper-ledger-test")).toThrow(/fee does not match/i);
  });

  it("persists batches atomically and idempotently", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    migrateTradingStore(database);
    const adapter = deterministicAdapter();
    await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    const events = adapter.getLedgerEvents();

    expect(appendPaperLedgerEventsTo(database, events)).toBe(events.length);
    expect(appendPaperLedgerEventsTo(database, events)).toBe(0);
    expect(listPaperLedgerEventsFrom(database, "paper-ledger-test")).toEqual(events);

    const bad = structuredClone(events.at(-1)!);
    bad.id = "conflicting-sequence";
    expect(() => appendPaperLedgerEventsTo(database, [bad])).toThrow(/sequence/i);
    expect(listPaperLedgerEventsFrom(database, "paper-ledger-test")).toEqual(events);
  });

  it("isolates contiguous sequences and idempotency keys by ledger epoch", async () => {
    const first = deterministicAdapter();
    const second = deterministicAdapter({ ledgerEpoch: 2, idPrefix: "epoch-two-event" });
    await first.execute(order({ action: "open", side: "buy", qty: 1, clientId: "epoch-one" }));
    await second.execute(order({ action: "open", side: "buy", qty: 1, clientId: "epoch-two" }));

    expect(first.getLedgerEvents().every((event) => event.ledgerEpoch === 1)).toBe(true);
    expect(second.getLedgerEvents().every((event) => event.ledgerEpoch === 2)).toBe(true);
    expect(() => replayPaperLedger(second.getLedgerEvents(), "paper-ledger-test", 1)).toThrow(/ledger epoch/i);

    const database = new DatabaseSync(":memory:");
    databases.push(database);
    migrateTradingStore(database);
    appendPaperLedgerEventsTo(database, first.getLedgerEvents());
    appendPaperLedgerEventsTo(database, second.getLedgerEvents());
    expect(listPaperLedgerEventsFrom(database, "paper-ledger-test", 1)).toEqual(first.getLedgerEvents());
    expect(listPaperLedgerEventsFrom(database, "paper-ledger-test", 2)).toEqual(second.getLedgerEvents());
  });

  it("replays a completed command without duplicating fills after restart", async () => {
    const command = order({ action: "open", side: "buy", qty: 1, clientId: "stable-paper-command" });
    const adapter = deterministicAdapter();
    const first = await adapter.execute(structuredClone(command));
    const eventCount = adapter.getLedgerEvents().length;
    const repeated = await adapter.execute(structuredClone(command));

    expect(repeated).toEqual(first);
    expect(adapter.getLedgerEvents()).toHaveLength(eventCount);
    expect(adapter.getLedgerState().fillCount).toBe(1);

    const restarted = new PaperAdapter({
      botId: "paper-ledger-test",
      ledgerEpoch: 1,
      market: "futures",
      startBalance: 1,
      feePct: 0,
      slipPct: 0,
      getPrice: () => 100,
      initialEvents: adapter.getLedgerEvents()
    });
    expect(await restarted.execute(structuredClone(command))).toEqual(first);
    expect(restarted.getLedgerEvents()).toHaveLength(eventCount);
    await expect(restarted.execute(order({
      action: "close",
      side: "sell",
      qty: 1,
      clientId: "stable-paper-command"
    }))).rejects.toThrow(/another request/i);
  });

  it("durably replays a no-price rejection after restart instead of opening later", async () => {
    let price = 0;
    let id = 0;
    const command = order({
      action: "open",
      side: "buy",
      qty: 1,
      clientId: "no-price-rejection"
    });
    const adapter = new PaperAdapter({
      botId: "paper-ledger-test",
      market: "futures",
      startBalance: 10_000,
      feePct: 0,
      slipPct: 0,
      getPrice: () => price,
      createId: () => `no-price-event-${++id}`
    });

    const rejected = await adapter.execute(structuredClone(command));
    expect(rejected).toMatchObject({ ok: false, message: "No market price available", fills: [] });
    const events = adapter.getLedgerEvents();
    expect(events.map((event) => event.type)).toContain("command_completed");

    price = 100;
    const restarted = new PaperAdapter({
      botId: "paper-ledger-test",
      market: "futures",
      startBalance: 1,
      feePct: 0,
      slipPct: 0,
      getPrice: () => price,
      initialEvents: events
    });
    await expect(restarted.execute(structuredClone(command))).resolves.toEqual(rejected);
    expect(restarted.getLedgerEvents()).toHaveLength(events.length);
    expect(restarted.getLedgerState()).toMatchObject({
      position: null,
      fillCount: 0
    });
  });

  it("rolls back the simulated mutation when durable append fails", async () => {
    const adapter = deterministicAdapter();
    const before = adapter.getState();
    const eventCount = adapter.getLedgerEvents().length;
    let writes = 0;
    adapter.setLedgerPersistence(() => {
      if (writes++ > 0) throw new Error("disk unavailable");
    });

    await expect(adapter.execute(order({ action: "open", side: "buy", qty: 1 }))).rejects.toThrow(/disk unavailable/);
    expect(adapter.getState()).toEqual(before);
    expect(adapter.getLedgerEvents()).toHaveLength(eventCount);
  });
});

describe("paper fees, funding and executable liquidity", () => {
  it("replays fees and verified funding exactly once without inventing accruals", async () => {
    const adapter = deterministicAdapter({ feePct: 0.1 });
    await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    expect(adapter.getState().balance).toBe(9_999.8);
    expect(adapter.getLedgerState()).toMatchObject({ feesPaid: 0.2, fundingNet: 0 });

    const settlement: VerifiedPaperFundingSettlement = {
      settlementId: "binance-BTCUSDT-1720000000000",
      symbol: "BTCUSDT",
      rate: 0.01,
      markPrice: 100,
      settledAt: 1_720_000_010_000,
      source: "verified-test-settlement",
      verified: true
    };
    expect(adapter.applyFundingSettlement(settlement)).toBe(-2);
    const afterFirst = adapter.getLedgerEvents().length;
    expect(adapter.applyFundingSettlement(settlement)).toBe(-2);
    expect(adapter.getLedgerEvents()).toHaveLength(afterFirst);
    expect(adapter.getState().balance).toBe(9_997.8);
    expect(adapter.getLedgerState()).toMatchObject({ feesPaid: 0.2, fundingNet: -2 });

    expect(() => adapter.applyFundingSettlement({ ...settlement, settlementId: "unverified", verified: false } as unknown as VerifiedPaperFundingSettlement))
      .toThrow(/verified settlement/);
    expect(adapter.getState().balance).toBe(9_997.8);
  });

  it("fails closed when a verified quote has insufficient exit liquidity", async () => {
    let quote: PaperExecutionQuote = { price: 101, availableQty: 2, source: "depth-snapshot", verified: true };
    const adapter = deterministicAdapter({ getExecutionQuote: () => quote });
    const opened = await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    expect(opened.fills[0].price).toBe(101);

    quote = { price: 110, availableQty: 1, source: "depth-snapshot", verified: true };
    const rejected = await adapter.execute(order({ action: "close", side: "sell" }));
    expect(rejected.ok).toBe(false);
    expect(adapter.getState().position?.qty).toBe(2);

    quote = { price: 109, availableQty: 2, source: "depth-snapshot", verified: true };
    const notCrossed = await adapter.execute(order({ action: "close", side: "sell", type: "limit", price: 110 }));
    expect(notCrossed.ok).toBe(false);
    expect(adapter.getState().position?.qty).toBe(2);

    quote = { price: 111, availableQty: 2, source: "depth-snapshot", verified: true };
    const closed = await adapter.execute(order({ action: "close", side: "sell", type: "limit", price: 110 }));
    expect(closed.ok).toBe(true);
    expect(closed.fills[0].price).toBe(111);
    expect(adapter.getState().position).toBeNull();
  });

  it("uses the executable quote for a crossed limit instead of granting the limit price", async () => {
    const adapter = deterministicAdapter({
      getExecutionQuote: () => ({ price: 95, availableQty: 1, source: "depth-snapshot", verified: true })
    });
    await adapter.execute(order({ side: "buy", type: "limit", qty: 1, price: 100 }));

    const fills = adapter.onPrice("BTCUSDT", 99);
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBe(95);
  });

  it("rejects a forged funding event during recovery", async () => {
    const adapter = deterministicAdapter();
    await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    adapter.applyFundingSettlement({
      settlementId: "settlement-1",
      symbol: "BTCUSDT",
      rate: 0.001,
      markPrice: 100,
      settledAt: 1_720_000_010_000,
      source: "verified-test-settlement",
      verified: true
    });
    const events = adapter.getLedgerEvents();
    const funding = events.find((event) => event.type === "funding");
    if (!funding || funding.type !== "funding") throw new Error("Funding fixture missing");
    funding.data.verified = false as true;

    expect(() => replayPaperLedger(events, "paper-ledger-test")).toThrow(/Unverified paper funding/);
  });

  it("imports a legacy snapshot once and then restores it only from events", () => {
    const adapter = deterministicAdapter();
    adapter.setState({
      balance: 9_500,
      leverage: 5,
      isolated: true,
      dualSide: false,
      position: { symbol: "BTCUSDT", side: "short", qty: 2, entryPrice: 120, leverage: 5, openedAt: 100 },
      orders: [{ id: "legacy-stop", symbol: "BTCUSDT", side: "buy", type: "stop_market", qty: 2, trgPrice: 130, reduceOnly: true, tif: "GTC", createdAt: 101 }]
    });
    const restored = new PaperAdapter({
      botId: "paper-ledger-test",
      market: "futures",
      startBalance: 1,
      feePct: 0,
      slipPct: 0,
      getPrice: () => 100,
      initialEvents: adapter.getLedgerEvents()
    });

    expect(restored.getState()).toEqual(adapter.getState());
    expect(() => adapter.setState(adapter.getState())).toThrow(/non-empty paper ledger/);
  });
});
