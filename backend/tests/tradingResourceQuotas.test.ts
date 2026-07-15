import { describe, expect, it } from "vitest";
import { assertRunningBotCapacity, DEFAULT_TRADING_RESOURCE_LIMITS, loadTradingResourceLimits } from "../src/trading/resourceQuotas.js";
import type { BotConfig } from "../src/trading/types.js";

describe("per-owner trading resource quotas", () => {
  it("loads documented defaults and explicit overrides", () => {
    expect(loadTradingResourceLimits({})).toEqual(DEFAULT_TRADING_RESOURCE_LIMITS);
    expect(
      loadTradingResourceLimits({
        TRADING_MAX_ACCOUNTS_PER_USER: "10",
        TRADING_MAX_BOTS_PER_USER: "30",
        TRADING_MAX_RUNNING_PAPER_BOTS_PER_USER: "6",
        TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER: "3"
      })
    ).toEqual({
      maxAccountsPerOwner: 10,
      maxBotsPerOwner: 30,
      maxRunningPaperBotsPerOwner: 6,
      maxRunningLiveBotsPerOwner: 3
    });
  });

  it("fails startup validation closed for invalid limits", () => {
    expect(() => loadTradingResourceLimits({ TRADING_MAX_BOTS_PER_USER: "0" })).toThrow("TRADING_MAX_BOTS_PER_USER");
    expect(() => loadTradingResourceLimits({ TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER: "2.5" })).toThrow("TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER");
  });

  it("maintains independent paper and live running caps", () => {
    const paper = { exchange: "paper" } as BotConfig;
    const live = { exchange: "bybit" } as BotConfig;
    const limits = { maxRunningPaperBotsPerOwner: 1, maxRunningLiveBotsPerOwner: 1 };

    expect(() => assertRunningBotCapacity([live], paper, limits)).not.toThrow();
    expect(() => assertRunningBotCapacity([paper], live, limits)).not.toThrow();
    expect(() => assertRunningBotCapacity([paper], paper, limits)).toThrowError(expect.objectContaining({ code: "PAPER_BOT_RUNNING_QUOTA_EXCEEDED", status: 429 }));
    expect(() => assertRunningBotCapacity([live], live, limits)).toThrowError(expect.objectContaining({ code: "LIVE_BOT_RUNNING_QUOTA_EXCEEDED", status: 429 }));
  });
});
