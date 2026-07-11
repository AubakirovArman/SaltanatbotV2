import {
  runHistoricalOrder,
  stepHistoricalOrder,
  type HistoricalOrder
} from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/types";

const candle = (overrides: Partial<Candle> = {}): Candle => ({
  time: 60_000,
  open: 100,
  high: 110,
  low: 90,
  close: 102,
  volume: 10,
  source: "Fixture",
  ...overrides
});

const order = (overrides: Partial<HistoricalOrder> = {}): HistoricalOrder => ({
  id: "order-1",
  side: "buy",
  type: "limit",
  qty: 5,
  filledQty: 0,
  price: 95,
  ...overrides
});

describe("canonical historical order simulator", () => {
  it("fills limits at the better gap open with maker fee in quote asset", () => {
    const step = stepHistoricalOrder(order(), candle({ open: 92 }), { commissionPct: 0.1, slippagePct: 1 });
    expect(step).toMatchObject({
      status: "filled",
      fill: { qty: 5, price: 92, fee: 0.46, feeAsset: "quote", liquidity: "maker" }
    });
  });

  it("fills adverse stop gaps as taker orders with slippage", () => {
    const step = stepHistoricalOrder(order({ type: "stop", price: 105 }), candle({ open: 108 }), {
      commissionPct: 0,
      slippagePct: 1
    });
    expect(step.fill).toMatchObject({ price: 109.08, liquidity: "taker" });
  });

  it("keeps untouched orders resting", () => {
    const step = stepHistoricalOrder(order({ price: 80 }), candle(), { commissionPct: 0, slippagePct: 0 });
    expect(step).toEqual({ order: order({ price: 80 }), status: "resting" });
  });

  it("applies volume participation across deterministic partial fills", () => {
    const steps = runHistoricalOrder(
      order({ qty: 5, participationPct: 20 }),
      [candle({ time: 1, volume: 10 }), candle({ time: 2, volume: 10 }), candle({ time: 3, volume: 10 })],
      { commissionPct: 0, slippagePct: 0 }
    );
    expect(steps.map((step) => ({ status: step.status, qty: step.fill?.qty, filled: step.order.filledQty }))).toEqual([
      { status: "partially_filled", qty: 2, filled: 2 },
      { status: "partially_filled", qty: 2, filled: 4 },
      { status: "filled", qty: 1, filled: 5 }
    ]);
    expect(runHistoricalOrder(order({ qty: 5, participationPct: 20 }), [candle(), candle(), candle()], { commissionPct: 0, slippagePct: 0 }))
      .toEqual(runHistoricalOrder(order({ qty: 5, participationPct: 20 }), [candle(), candle(), candle()], { commissionPct: 0, slippagePct: 0 }));
  });

  it("does not invent liquidity when reported candle volume is zero", () => {
    const step = stepHistoricalOrder(order(), candle({ volume: 0 }), { commissionPct: 0, slippagePct: 0 });
    expect(step.status).toBe("resting");
    expect(step.fill).toBeUndefined();
  });
});
