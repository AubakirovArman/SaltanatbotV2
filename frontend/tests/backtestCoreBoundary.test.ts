import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "@saltanatbotv2/backtest-core";
import * as brokerFacade from "../src/strategy/backtest/broker";
import * as metricsFacade from "../src/strategy/backtestMetrics";
import * as portfolioFacade from "../src/strategy/backtest/portfolio";

const packageRoot = fileURLToPath(new URL("../../packages/backtest-core/", import.meta.url));

describe("backtest-core package boundary", () => {
  it("keeps frontend compatibility facades wired to canonical functions", () => {
    expect(brokerFacade.applySlippage).toBe(core.applySlippage);
    expect(portfolioFacade.closeBacktestPosition).toBe(core.closeBacktestPosition);
    expect(metricsFacade.computeBacktestMetrics).toBe(core.computeBacktestMetrics);
  });

  it("does not import UI, browser or frontend implementation code", () => {
    const sources = readdirSync(packageRoot)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => readFileSync(new URL(`../../packages/backtest-core/${file}`, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/from\s+["'](?:react|blockly|react-dom)(?:[\/"'])/i);
    expect(sources).not.toMatch(/\b(?:window|document|localStorage)\.[A-Za-z_$]/);
    expect(sources).not.toMatch(/\bnew\s+WebSocket\b/);
    expect(sources).not.toMatch(/frontend\/src|(?:\.\.\/)+frontend|chart\//i);
  });
});
