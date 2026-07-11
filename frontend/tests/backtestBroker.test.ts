import { describe, expect, it } from "vitest";
import {
  applySlippage,
  resolveSize,
  resolveStop,
  resolveTarget,
  stopHit,
  targetHit,
  unrealized,
  type Position
} from "../src/strategy/backtest/broker";
import type { BacktestConfig } from "../src/strategy/backtestTypes";
import type { Candle } from "../src/types";

const config: Required<BacktestConfig> = {
  initialCapital: 10_000,
  commissionPct: 0,
  slippagePct: 1,
  allowShort: true,
  fillTiming: "next_open",
  maxLeverage: 2,
  qtyStep: 0.1,
  fundingRatePctPer8h: 0
};

function position(overrides: Partial<Position> = {}): Position {
  return {
    dir: "long",
    qty: 2,
    entryPrice: 100,
    entryIndex: 0,
    entryTime: 0,
    maeAbs: 0,
    mfeAbs: 0,
    ...overrides
  };
}

const candle: Candle = { time: 0, open: 100, high: 110, low: 90, close: 105, volume: 1 };

describe("backtest broker primitives", () => {
  it("always applies slippage against the simulated order", () => {
    expect(applySlippage(100, "long", true, config)).toBe(101);
    expect(applySlippage(100, "long", false, config)).toBe(99);
    expect(applySlippage(100, "short", true, config)).toBe(99);
    expect(applySlippage(100, "short", false, config)).toBe(101);
  });

  it("resolves percent and ATR protection symmetrically", () => {
    expect(resolveStop("long", 100, { mode: "percent", value: 5 }, 10)).toBe(95);
    expect(resolveStop("short", 100, { mode: "atr", value: 2 }, 10)).toBe(120);
    expect(resolveTarget("long", 100, { mode: "atr", value: 2 }, 10)).toBe(120);
    expect(resolveTarget("short", 100, { mode: "percent", value: 5 }, 10)).toBe(95);
  });

  it("rejects undefined risk sizing and caps notional at configured leverage", () => {
    expect(resolveSize({ mode: "risk_pct", value: 1 }, 10_000, 100, undefined, config)).toEqual({
      qty: 0,
      warning: "Skipped risk_pct entry: no stop set, so risk-based size is undefined."
    });
    expect(resolveSize({ mode: "units", value: 1000 }, 10_000, 100, 90, config)).toEqual({
      qty: 200,
      warning: "Position clipped to 2x leverage (requested notional exceeded margin)."
    });
  });

  it("detects protective hits and calculates directional unrealized PnL", () => {
    expect(stopHit(position({ stopPrice: 95 }), candle)).toBe(true);
    expect(targetHit(position({ targetPrice: 108 }), candle)).toBe(true);
    expect(unrealized(position(), 105)).toBe(10);
    expect(unrealized(position({ dir: "short" }), 105)).toBe(-10);
    expect(unrealized(null, 105)).toBe(0);
  });
});
