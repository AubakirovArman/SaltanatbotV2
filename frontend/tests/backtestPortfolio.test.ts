import { describe, expect, it } from "vitest";
import {
  closeBacktestPosition,
  openBacktestPosition
} from "../src/strategy/backtest/portfolio";
import type { Position } from "../src/strategy/backtest/broker";
import type { BacktestConfig } from "../src/strategy/backtestTypes";

const config: Required<BacktestConfig> = {
  initialCapital: 10_000,
  commissionPct: 0.1,
  slippagePct: 0,
  allowShort: true,
  fillTiming: "next_open",
  maxLeverage: 5,
  qtyStep: 0,
  fundingRatePctPer8h: 0
};

describe("backtest portfolio accounting", () => {
  it("opens a sized position with seeded trailing protection", () => {
    const opened = openBacktestPosition({
      direction: "long",
      fill: 100,
      index: 3,
      time: 3000,
      trail: { mode: "atr", value: 2 },
      target: { mode: "percent", value: 10 },
      size: { mode: "units", value: 2 },
      atr: 5,
      equity: 10_000,
      config
    });

    expect(opened.position).toMatchObject({
      dir: "long",
      qty: 2,
      entryPrice: 100,
      stopPrice: 90,
      trail: { mode: "atr", value: 2 }
    });
    expect(opened.position?.targetPrice).toBeCloseTo(110);
    expect(opened.marker).toEqual({ time: 3000, price: 100, kind: "buy", label: "Long 100.00" });
  });

  it("returns a warning without a position when risk sizing has no stop", () => {
    const opened = openBacktestPosition({
      direction: "short",
      fill: 100,
      index: 0,
      time: 0,
      size: { mode: "risk_pct", value: 1 },
      atr: 0,
      equity: 10_000,
      config
    });

    expect(opened.position).toBeUndefined();
    expect(opened.warning).toContain("no stop set");
  });

  it("closes with round-trip commission and preserves excursion metrics", () => {
    const position: Position = {
      dir: "long",
      qty: 2,
      entryPrice: 100,
      entryIndex: 2,
      entryTime: 2000,
      maeAbs: -10,
      mfeAbs: 30
    };
    const closed = closeBacktestPosition({
      position,
      index: 7,
      time: 7000,
      price: 110,
      reason: "target",
      commissionPct: 0.1
    });

    // Gross 20 minus 0.42 round-trip commission.
    expect(closed.equityDelta).toBeCloseTo(19.58);
    expect(closed.trade).toMatchObject({
      pnl: 19.58,
      pnlPct: 9.79,
      barsHeld: 5,
      maePct: -5,
      mfePct: 15,
      reason: "target"
    });
    expect(closed.marker).toEqual({ time: 7000, price: 110, kind: "exit", label: "Exit 110.00" });
  });
});
