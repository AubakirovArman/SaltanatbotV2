import { beforeEach, describe, expect, it } from "vitest";
import { PaperAdapter } from "../src/trading/exchange/paper.js";
import type { ExecOrder } from "../src/trading/types.js";

/**
 * The PaperAdapter is a pure, in-memory exchange: it holds balance + one
 * position + a resting order book, and prices come from an injected callback.
 * No DB, no network. These tests verify the money-critical paths: fill
 * price/qty/fee, resting stop/limit/TP triggering, realized PnL sign+magnitude,
 * and reduce-only close semantics.
 */

// A live price we can move between ticks.
let price = 100;

function makeAdapter(opts?: { feePct?: number; slipPct?: number; startBalance?: number }) {
  price = 100;
  return new PaperAdapter({
    botId: "test-bot",
    market: "futures",
    startBalance: opts?.startBalance ?? 10_000,
    feePct: opts?.feePct ?? 0,
    slipPct: opts?.slipPct ?? 0,
    getPrice: () => price,
  });
}

function order(overrides: Partial<ExecOrder>): ExecOrder {
  return {
    action: "neworder",
    market: "futures",
    symbol: "BTCUSDT",
    type: "market",
    reason: "test",
    ...overrides,
  };
}

describe("PaperAdapter — opening a position", () => {
  let adapter: PaperAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it("opens a long at the mark with the requested qty and zero fee (feePct=0)", async () => {
    const result = await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    expect(result.ok).toBe(true);
    expect(result.fills).toHaveLength(1);
    const fill = result.fills[0];
    expect(fill.kind).toBe("open");
    expect(fill.side).toBe("buy");
    expect(fill.qty).toBe(2);
    expect(fill.price).toBe(100);
    expect(fill.fee).toBe(0);
    expect(fill.realizedPnl).toBe(0);

    const state = adapter.getState();
    expect(state.position).not.toBeNull();
    expect(state.position?.side).toBe("long");
    expect(state.position?.qty).toBe(2);
    expect(state.position?.entryPrice).toBe(100);
    // No fee -> balance unchanged on open.
    expect(state.balance).toBe(10_000);
  });

  it("charges a fee on open equal to qty * price * feePct/100", async () => {
    adapter = makeAdapter({ feePct: 0.1 }); // 0.1%
    const result = await adapter.execute(order({ action: "open", side: "buy", qty: 2 }));
    const fill = result.fills[0];
    // 2 * 100 * 0.001 = 0.2
    expect(fill.fee).toBeCloseTo(0.2, 9);
    expect(adapter.getState().balance).toBeCloseTo(10_000 - 0.2, 9);
  });

  it("applies slippage to the entry fill (long entry fills higher)", async () => {
    adapter = makeAdapter({ slipPct: 1 }); // 1%
    const result = await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    // long entry -> worse = up -> 100 * 1.01
    expect(result.fills[0].price).toBeCloseTo(101, 9);
  });

  it("refuses to open a second position on the same symbol", async () => {
    await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    const again = await adapter.execute(order({ action: "open", side: "buy", qty: 1 }));
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already/i);
  });
});

describe("PaperAdapter — realized PnL on close", () => {
  it("realizes a POSITIVE PnL when a long is closed higher", async () => {
    const adapter = makeAdapter();
    await adapter.execute(order({ action: "open", side: "buy", qty: 3 })); // entry @ 100
    price = 110;
    const result = await adapter.execute(order({ action: "close", side: "sell" }));
    const fill = result.fills[0];
    expect(fill.kind).toBe("close");
    // gross = 3 * (110 - 100) = 30, no fee
    expect(fill.realizedPnl).toBeCloseTo(30, 9);
    expect(fill.realizedPnl).toBeGreaterThan(0);
    expect(adapter.getState().position).toBeNull();
    expect(adapter.getState().balance).toBeCloseTo(10_030, 9);
  });

  it("realizes a NEGATIVE PnL when a long is closed lower", async () => {
    const adapter = makeAdapter();
    await adapter.execute(order({ action: "open", side: "buy", qty: 3 })); // entry @ 100
    price = 90;
    const result = await adapter.execute(order({ action: "close", side: "sell" }));
    // gross = 3 * (90 - 100) = -30
    expect(result.fills[0].realizedPnl).toBeCloseTo(-30, 9);
    expect(result.fills[0].realizedPnl).toBeLessThan(0);
    expect(adapter.getState().balance).toBeCloseTo(9_970, 9);
  });

  it("realizes a POSITIVE PnL when a short is closed lower", async () => {
    const adapter = makeAdapter();
    await adapter.execute(order({ action: "open", side: "sell", qty: 2 })); // short entry @ 100
    price = 80;
    const result = await adapter.execute(order({ action: "close", side: "buy" }));
    // short gross = 2 * (100 - 80) = 40
    expect(result.fills[0].realizedPnl).toBeCloseTo(40, 9);
    expect(adapter.getState().balance).toBeCloseTo(10_040, 9);
  });

  it("subtracts the close fee from realized PnL", async () => {
    const adapter = makeAdapter({ feePct: 0.1 });
    await adapter.execute(order({ action: "open", side: "buy", qty: 1 })); // fee 0.1 on open
    price = 110;
    const result = await adapter.execute(order({ action: "close", side: "sell" }));
    // gross 10, close fee = 1 * 110 * 0.001 = 0.11 -> pnl 9.89
    expect(result.fills[0].fee).toBeCloseTo(0.11, 9);
    expect(result.fills[0].realizedPnl).toBeCloseTo(9.89, 9);
  });
});

describe("PaperAdapter — reduce-only close", () => {
  it("partially reduces a long with closePct and keeps the remainder", async () => {
    const adapter = makeAdapter();
    await adapter.execute(order({ action: "open", side: "buy", qty: 4 }));
    price = 120;
    const result = await adapter.execute(order({ action: "close", side: "sell", closePct: 50 }));
    // close 2 units: gross 2 * (120 - 100) = 40
    expect(result.fills[0].qty).toBe(2);
    expect(result.fills[0].realizedPnl).toBeCloseTo(40, 9);
    expect(adapter.getState().position?.qty).toBe(2);
  });

  it("a reduce-only market order routes to a close, never opens a new position", async () => {
    const adapter = makeAdapter();
    // No position: a reduce-only order must not open anything.
    const result = await adapter.execute(order({ action: "neworder", side: "sell", qty: 1, reduceOnly: true }));
    expect(result.ok).toBe(false);
    expect(adapter.getState().position).toBeNull();
  });
});

describe("PaperAdapter — resting orders trigger on price ticks", () => {
  it("fills a resting LIMIT buy when price drops to the limit, at the LIMIT price", async () => {
    const adapter = makeAdapter();
    // Place a resting buy-limit at 95 while price is 100.
    const placed = await adapter.execute(order({ side: "buy", type: "limit", price: 95, qty: 1 }));
    expect(placed.ok).toBe(true);
    expect(placed.fills).toHaveLength(0);
    expect(adapter.getState().orders).toHaveLength(1);

    // Not triggered yet at 96.
    expect(adapter.onPrice("BTCUSDT", 96)).toHaveLength(0);
    // Triggered at 94 -> fills at the limit price 95 (not the tick price).
    const fills = adapter.onPrice("BTCUSDT", 94);
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBe(95);
    expect(adapter.getState().position?.side).toBe("long");
    expect(adapter.getState().orders).toHaveLength(0);
  });

  it("triggers a resting protective STOP on a long and realizes the loss", async () => {
    const adapter = makeAdapter();
    // Open long @ 100 with a 5% stop attached.
    await adapter.execute(
      order({ action: "open", side: "buy", qty: 2, stop: { basis: "percent", value: 5 } })
    );
    const stopOrder = adapter.getState().orders.find((o) => o.type === "stop_market");
    expect(stopOrder).toBeDefined();
    expect(stopOrder?.reduceOnly).toBe(true);
    // Stop level = 100 * (1 - 0.05) = 95.
    expect(stopOrder?.trgPrice).toBeCloseTo(95, 9);

    // Above the stop: nothing.
    expect(adapter.onPrice("BTCUSDT", 96)).toHaveLength(0);
    // Cross the stop downward -> stop-market fills at the tick price (94).
    const fills = adapter.onPrice("BTCUSDT", 94);
    expect(fills).toHaveLength(1);
    expect(fills[0].kind).toBe("close");
    // Loss = 2 * (94 - 100) = -12.
    expect(fills[0].realizedPnl).toBeCloseTo(-12, 9);
    expect(fills[0].realizedPnl).toBeLessThan(0);
    expect(adapter.getState().position).toBeNull();
    // Resting protective orders are cleaned up once the position is flat.
    expect(adapter.getState().orders).toHaveLength(0);
  });

  it("triggers a resting TAKE-PROFIT on a long and realizes the gain", async () => {
    const adapter = makeAdapter();
    // Open long @ 100 with a +10% TP for the full size.
    await adapter.execute(
      order({
        action: "open",
        side: "buy",
        qty: 2,
        takeProfits: [{ priceBasis: "percent", price: 10, qtyBasis: "percent", qty: 100 }],
      })
    );
    const tp = adapter.getState().orders.find((o) => o.type.startsWith("tp"));
    expect(tp?.trgPrice).toBeCloseTo(110, 9); // 100 * 1.10
    expect(tp?.reduceOnly).toBe(true);

    // Below target: nothing.
    expect(adapter.onPrice("BTCUSDT", 105)).toHaveLength(0);
    // Reach the target -> TP-market fills at the tick price (111).
    const fills = adapter.onPrice("BTCUSDT", 111);
    expect(fills).toHaveLength(1);
    // gain = 2 * (111 - 100) = 22
    expect(fills[0].realizedPnl).toBeCloseTo(22, 9);
    expect(fills[0].realizedPnl).toBeGreaterThan(0);
    expect(adapter.getState().position).toBeNull();
  });

  it("triggers a protective STOP on a SHORT (price rises through the stop)", async () => {
    const adapter = makeAdapter();
    await adapter.execute(
      order({ action: "open", side: "sell", qty: 1, stop: { basis: "percent", value: 5 } })
    );
    const stop = adapter.getState().orders.find((o) => o.type === "stop_market");
    // Short stop = 100 * (1 + 0.05) = 105, closing side buy.
    expect(stop?.trgPrice).toBeCloseTo(105, 9);
    expect(stop?.side).toBe("buy");

    expect(adapter.onPrice("BTCUSDT", 104)).toHaveLength(0);
    const fills = adapter.onPrice("BTCUSDT", 106);
    expect(fills).toHaveLength(1);
    // short loss = 1 * (100 - 106) = -6
    expect(fills[0].realizedPnl).toBeCloseTo(-6, 9);
    expect(adapter.getState().position).toBeNull();
  });
});
