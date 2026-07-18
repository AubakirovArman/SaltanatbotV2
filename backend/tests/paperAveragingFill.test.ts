import { describe, expect, it } from "vitest";
import { PaperAdapter, type PaperFillBehavior } from "../src/trading/exchange/paper.js";
import { replayPaperLedger } from "../src/trading/paperLedger.js";
import type { ExecOrder } from "../src/trading/types.js";

/**
 * Versioned same-side fill semantics. `averaging-v1` (DCA robots) merges
 * same-side adds into a volume-weighted average entry; the default
 * `single-position-v1` stays byte-compatible with every historical ledger and
 * now cancels a triggered-but-unfillable entry explicitly instead of silently
 * dropping it.
 */

let price = 100;

function order(overrides: Partial<ExecOrder>): ExecOrder {
  return {
    action: "neworder",
    market: "futures",
    symbol: "BTCUSDT",
    type: "market",
    reason: "averaging-test",
    ...overrides
  };
}

function adapter(overrides: { fillBehavior?: PaperFillBehavior; feePct?: number; idPrefix?: string } = {}) {
  price = 100;
  let id = 0;
  return new PaperAdapter({
    botId: "paper-averaging-test",
    market: "futures",
    startBalance: 10_000,
    feePct: overrides.feePct ?? 0.1,
    slipPct: 0,
    fillBehavior: overrides.fillBehavior,
    getPrice: () => price,
    now: () => 1_730_000_000_000 + id,
    createId: () => `${overrides.idPrefix ?? "event"}-${++id}`
  });
}

describe("averaging-v1 same-side merges", () => {
  it("merges a same-side market add into the volume-weighted average entry", async () => {
    const paper = adapter({ fillBehavior: "averaging-v1" });
    await paper.execute(order({ side: "buy", qty: 1 }));
    const openedAt = paper.getState().position?.openedAt;
    price = 90;
    const added = await paper.execute(order({ side: "buy", qty: 1 }));

    expect(added.ok).toBe(true);
    expect(added.fills[0]).toMatchObject({ kind: "open", side: "buy", qty: 1, price: 90, realizedPnl: 0 });
    // fee = 1 * 90 * 0.001 = 0.09 on the add; 0.1 on the base entry.
    expect(added.fills[0].fee).toBeCloseTo(0.09, 9);
    const position = paper.getState().position;
    expect(position?.qty).toBe(2);
    expect(position?.entryPrice).toBeCloseTo(95, 9);
    expect(position?.openedAt).toBe(openedAt);
    expect(paper.getState().balance).toBeCloseTo(10_000 - 0.1 - 0.09, 9);
  });

  it("weights the merged entry by quantity and realizes PnL from the average", async () => {
    const paper = adapter({ fillBehavior: "averaging-v1", feePct: 0 });
    await paper.execute(order({ side: "buy", qty: 1 })); // 1 @ 100
    price = 80;
    await paper.execute(order({ side: "buy", qty: 3 })); // 3 @ 80 -> entry 85
    expect(paper.getState().position?.entryPrice).toBeCloseTo(85, 9);

    price = 110;
    const closed = await paper.execute(order({ action: "close", side: "sell" }));
    expect(closed.fills[0].realizedPnl).toBeCloseTo(4 * (110 - 85), 9);
    expect(paper.getState().position).toBeNull();
    expect(paper.getState().balance).toBeCloseTo(10_100, 9);
  });

  it("fills a triggered same-side safety limit and mirrors shorts", async () => {
    const paper = adapter({ fillBehavior: "averaging-v1", feePct: 0 });
    await paper.execute(order({ side: "sell", qty: 1 })); // short 1 @ 100
    await paper.execute(order({ side: "sell", type: "limit", qty: 1, price: 110, clientId: "safety-1" }));

    const fills = paper.onPrice("BTCUSDT", 111);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ kind: "open", side: "sell", qty: 1, price: 110, clientId: "safety-1" });
    expect(paper.getState().position).toMatchObject({ side: "short", qty: 2 });
    expect(paper.getState().position?.entryPrice).toBeCloseTo(105, 9);
    expect(paper.getState().orders).toHaveLength(0);

    price = 90;
    const closed = await paper.execute(order({ action: "close", side: "buy" }));
    expect(closed.fills[0].realizedPnl).toBeCloseTo(2 * (105 - 90), 9);
  });

  it("records replayable fee, position and cash events for an averaging ledger", async () => {
    const paper = adapter({ fillBehavior: "averaging-v1" });
    await paper.execute(order({ side: "buy", qty: 1 }));
    await paper.execute(order({ side: "buy", type: "limit", qty: 1, price: 90, clientId: "safety-1" }));
    paper.onPrice("BTCUSDT", 89);
    price = 120;
    await paper.execute(order({ action: "close", side: "sell" }));

    const events = paper.getLedgerEvents();
    const addFill = events.find((event) => event.type === "fill" && event.data.fill.reason === "trigger:limit");
    if (!addFill || addFill.type !== "fill") throw new Error("Averaging fill fixture missing");
    expect(addFill.data.fill.kind).toBe("open");
    expect(events.some((event) => event.type === "fee" && event.data.fillId === addFill.data.fill.id)).toBe(true);
    expect(events.some((event) => event.type === "cash" && event.data.fillId === addFill.data.fill.id)).toBe(false);
    const merged = events.filter((event) => event.type === "position").at(-2);
    if (!merged || merged.type !== "position") throw new Error("Merged position fixture missing");
    expect(merged.data.position?.qty).toBe(2);
    expect(merged.data.position?.entryPrice).toBeCloseTo(95, 9);

    // The fail-closed reducer accepts the averaging ledger exactly as recorded.
    expect(replayPaperLedger(events, "paper-averaging-test")).toEqual(paper.getLedgerState());
    const restored = new PaperAdapter({
      botId: "paper-averaging-test",
      market: "futures",
      startBalance: 1,
      feePct: 0.1,
      slipPct: 0,
      fillBehavior: "averaging-v1",
      getPrice: () => price,
      initialEvents: events
    });
    expect(restored.getState()).toEqual(paper.getState());
  });

  it("still rejects tampered fee accounting on averaging ledgers", async () => {
    const paper = adapter({ fillBehavior: "averaging-v1" });
    await paper.execute(order({ side: "buy", qty: 1 }));
    price = 90;
    await paper.execute(order({ side: "buy", qty: 1 }));
    const events = paper.getLedgerEvents();
    const fee = events.filter((event) => event.type === "fee").at(-1);
    if (!fee || fee.type !== "fee") throw new Error("Fee fixture missing");
    fee.data.amount += 1;
    expect(() => replayPaperLedger(events, "paper-averaging-test")).toThrow(/fee does not match/i);
  });
});

describe("single-position-v1 stays byte-compatible and cancels explicitly", () => {
  it("keeps the default behavior identical to an explicit single-position-v1 adapter", async () => {
    const implicit = adapter({});
    const explicit = adapter({ fillBehavior: "single-position-v1" });
    for (const paper of [implicit, explicit]) {
      price = 100;
      await paper.execute(order({ side: "buy", qty: 1, clientId: "entry" }));
      price = 90;
      await paper.execute(order({ side: "buy", qty: 1, clientId: "add-attempt" }));
    }
    expect(implicit.getLedgerEvents()).toEqual(explicit.getLedgerEvents());
    expect(implicit.getState().position?.qty).toBe(1);
  });

  it("cancels a triggered same-side entry with an explicit versioned reason", async () => {
    const paper = adapter({});
    await paper.execute(order({ side: "buy", qty: 1 }));
    const placed = await paper.execute(order({ side: "buy", type: "limit", qty: 1, price: 90, clientId: "same-side" }));
    const orderId = placed.pendingOrder?.id;
    expect(orderId).toBeDefined();

    const fills = paper.onPrice("BTCUSDT", 89);
    expect(fills).toHaveLength(0);
    expect(paper.getState().orders).toHaveLength(0);
    expect(paper.getState().position?.qty).toBe(1);

    const cancelled = paper.getLedgerEvents().find((event) => event.type === "order_cancelled" && event.data.orderId === orderId);
    if (!cancelled || cancelled.type !== "order_cancelled") throw new Error("Explicit cancellation event missing");
    expect(cancelled.data.reason).toBe("position-conflict:single-position-v1");
    expect(replayPaperLedger(paper.getLedgerEvents(), "paper-averaging-test").orders).toHaveLength(0);
  });
});
