import { describe, expect, it } from "vitest";
import { resolveTradingRuntime } from "../src/trading/runtimeProfile";
import { readableRunningBots } from "../src/hooks/useLivePositions";
import type { TradingBot } from "../src/trading/tradeClient";

describe("trading runtime profile", () => {
  it("preserves legacy backend behavior when capability fields are omitted", () => {
    expect(resolveTradingRuntime({ demo: false })).toEqual({
      paperOnly: false,
      privateExchangeRequests: true,
      credentialWrites: true
    });
  });

  it("resolves the public HTTP profile fail-closed", () => {
    expect(resolveTradingRuntime({
      runtimeProfile: "public-http-paper",
      executionMode: "paper-only",
      privateExchangeRequests: false,
      credentialWrites: false,
      demo: false
    })).toEqual({
      paperOnly: true,
      privateExchangeRequests: false,
      credentialWrites: false
    });
  });

  it("treats legacy demo and contradictory paper-only responses as safe mode", () => {
    expect(resolveTradingRuntime({ demo: true })).toMatchObject({ paperOnly: true, privateExchangeRequests: false, credentialWrites: false });
    expect(resolveTradingRuntime({ executionMode: "paper-only", privateExchangeRequests: true, credentialWrites: true })).toMatchObject({ paperOnly: true, privateExchangeRequests: false, credentialWrites: false });
  });
});

describe("paper-only chart position filtering", () => {
  it("never requests private live snapshots for persisted exchange bots", () => {
    const makeBot = (id: string, exchange: TradingBot["exchange"]): TradingBot => ({
      id,
      name: id,
      strategyName: "Strategy",
      ir: {} as TradingBot["ir"],
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange,
      market: "futures",
      sizeMode: "quote",
      sizeValue: 100,
      leverage: 1,
      notifyMarkers: false,
      status: "running",
      createdAt: 1,
      updatedAt: 1
    });
    const paper = makeBot("paper", "paper");
    const live = makeBot("live", "bybit");

    expect(readableRunningBots([paper, live], "BTCUSDT", true)).toEqual([paper]);
    expect(readableRunningBots([paper, live], "BTCUSDT", false)).toEqual([paper, live]);
  });
});
