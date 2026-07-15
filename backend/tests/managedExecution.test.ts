import { describe, expect, it } from "vitest";
import { isReduceOnlyExecution, pausedOrderAllowed } from "../src/trading/managedExecution.js";
import type { ExecOrder } from "../src/trading/types.js";

function order(overrides: Partial<ExecOrder> = {}): ExecOrder {
  return {
    action: "neworder",
    market: "futures",
    symbol: "BTCUSDT",
    side: "buy",
    type: "market",
    qty: 1,
    reason: "test",
    ...overrides
  };
}

describe("paused managed execution policy", () => {
  it("allows venue-enforced futures reductions and spot inventory sells", () => {
    expect(pausedOrderAllowed(order({ reduceOnly: true }))).toBe(true);
    expect(pausedOrderAllowed(order({ market: "spot", side: "sell", reduceOnly: true }))).toBe(true);
    expect(isReduceOnlyExecution(order({ action: "close", reduceOnly: false }))).toBe(true);
  });

  it("does not let a meaningless spot reduceOnly flag bypass the pause gate", () => {
    expect(pausedOrderAllowed(order({ market: "spot", side: "buy", reduceOnly: true }))).toBe(false);
  });

  it("allows cancellation and reads but blocks entries and settings mutations", () => {
    expect(pausedOrderAllowed(order({ action: "cancelall" }))).toBe(true);
    expect(pausedOrderAllowed(order({ action: "get" }))).toBe(true);
    expect(pausedOrderAllowed(order({ action: "open" }))).toBe(false);
    expect(pausedOrderAllowed(order({ action: "turnover", reduceOnly: true }))).toBe(false);
    expect(pausedOrderAllowed(order({ action: "set" }))).toBe(false);
  });
});
