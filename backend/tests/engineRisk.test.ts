import { describe, expect, it } from "vitest";
import { resolvePositionQty, resolveStopPrice, resolveTargetPrice } from "../src/trading/engineRisk.js";
import type { BarIntents } from "../src/trading/strategy/evaluator.js";
import type { BotConfig } from "../src/trading/types.js";

const config: BotConfig = {
  id: "risk-test",
  name: "Risk test",
  strategyName: "Risk test",
  ir: { name: "Risk test", inputs: [], body: [] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange: "paper",
  market: "futures",
  sizeMode: "quote",
  sizeValue: 1_000,
  leverage: 5,
  notifyMarkers: false,
  status: "stopped",
  createdAt: 0,
  updatedAt: 0
};
const intents: BarIntents = { exit: false, alerts: [], markers: [] };

describe("trading engine risk helpers", () => {
  it("converts default quote sizing into base units", () => {
    expect(resolvePositionQty(config, intents, 50_000, 10_000)).toBeCloseTo(0.02);
  });

  it("uses leverage for equity sizing and stop distance for risk sizing", () => {
    expect(resolvePositionQty(config, { ...intents, size: { mode: "equity_pct", value: 10 } }, 100, 10_000)).toBe(50);
    expect(resolvePositionQty(config, { ...intents, size: { mode: "risk_pct", value: 2 } }, 100, 10_000, 95)).toBe(40);
  });

  it("fails closed when risk sizing has no stop", () => {
    expect(resolvePositionQty(config, { ...intents, size: { mode: "risk_pct", value: 2 } }, 100, 10_000)).toBe(0);
  });

  it("resolves percent and ATR stops symmetrically", () => {
    expect(resolveStopPrice({ mode: "percent", value: 5 }, "long", 100, 10)).toBe(95);
    expect(resolveStopPrice({ mode: "percent", value: 5 }, "short", 100, 10)).toBe(105);
    expect(resolveStopPrice({ mode: "atr", value: 2 }, "long", 100, 10)).toBe(80);
  });

  it("resolves percent and ATR targets symmetrically", () => {
    expect(resolveTargetPrice({ mode: "percent", value: 5 }, "long", 100, 10)).toBe(105);
    expect(resolveTargetPrice({ mode: "percent", value: 5 }, "short", 100, 10)).toBe(95);
    expect(resolveTargetPrice({ mode: "atr", value: 2 }, "short", 100, 10)).toBe(80);
  });
});
