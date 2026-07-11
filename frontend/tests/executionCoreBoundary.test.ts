import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as executionCore from "@saltanatbotv2/execution-core";
import { resolvePositionQty, resolveStopPrice } from "../../backend/src/trading/engineRisk.js";
import { canApplySnapshot } from "../../backend/src/trading/orderLifecycle.js";
import { applySlippage, resolveSize } from "../src/strategy/backtest/broker";
import type { BacktestConfig } from "../src/strategy/backtestTypes";
import type { BotConfig, OrderJournalRecord } from "../../backend/src/trading/types.js";

const packageRoot = fileURLToPath(new URL("../../packages/execution-core/", import.meta.url));
const backtestConfig: Required<BacktestConfig> = {
  initialCapital: 10_000,
  commissionPct: 0,
  slippagePct: 1,
  allowShort: true,
  fillTiming: "next_open",
  maxLeverage: 2,
  qtyStep: 0,
  fundingRatePctPer8h: 0,
};

const botConfig: BotConfig = {
  id: "execution-core",
  name: "Execution core",
  strategyName: "Execution core",
  ir: { name: "Execution core", inputs: [], body: [] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange: "paper",
  market: "futures",
  sizeMode: "equity_pct",
  sizeValue: 10,
  leverage: 2,
  notifyMarkers: false,
  status: "stopped",
  createdAt: 0,
  updatedAt: 0,
};

describe("execution-core package boundary", () => {
  it("keeps historical and runtime price/sizing semantics on the canonical primitives", () => {
    expect(applySlippage(100, "long", true, backtestConfig)).toBe(
      executionCore.applyExecutionSlippage(100, "long", true, 1),
    );
    expect(resolveStopPrice({ mode: "percent", value: 5 }, "long", 100, 0)).toBe(
      executionCore.resolveProtectionPrice("stop", "long", 100, { mode: "percent", value: 5 }, 0),
    );
    expect(resolvePositionQty(botConfig, { exit: false, alerts: [], markers: [] }, 100, 10_000)).toBe(20);
    expect(resolveSize(
      { mode: "equity_pct", value: 10 },
      10_000,
      100,
      undefined,
      backtestConfig,
    ).qty).toBe(executionCore.resolveExecutionSize(
      { mode: "equity_pct", value: 10 },
      10_000,
      100,
      undefined,
      { leverage: 1, maxLeverage: 2, qtyStep: 0 },
    ).qty);
  });

  it("uses the canonical monotonic order-state transition rule", () => {
    const record = {
      status: "partially_filled",
      filledQty: 1,
    } as OrderJournalRecord;
    const snapshot = {
      id: "order-1",
      status: "filled",
      qty: 2,
      filledQty: 2,
      updatedAt: 1,
    } as const;
    expect(canApplySnapshot(record, snapshot)).toBe(true);
    expect(executionCore.canAdvanceOrderState(record, snapshot)).toBe(true);
    expect(canApplySnapshot({ ...record, status: "filled" }, { ...snapshot, status: "accepted" })).toBe(false);
  });

  it("does not import UI, browser, storage or transport implementations", () => {
    const sources = readdirSync(packageRoot)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => readFileSync(new URL(`../../packages/execution-core/${file}`, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/from\s+["'](?:react|blockly|express|ws)(?:[\/"'])/i);
    expect(sources).not.toMatch(/\b(?:window|document|localStorage|fetch)\b/);
    expect(sources).not.toMatch(/backend\/src|frontend\/src|node:(?:fs|sqlite|http|crypto)/i);
  });
});
