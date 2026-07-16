import { describe, expect, it } from "vitest";
import { parseTradeEvent, presentBotForRuntime, shouldLoadBotRuntime } from "./TradingView";
import type { TradingBot } from "../trading/tradeClient";

describe("trading event boundary", () => {
  it("accepts only known events with a bot identity", () => {
    expect(parseTradeEvent(JSON.stringify({ type: "bot", botId: "bot-1" }))).toMatchObject({ type: "bot", botId: "bot-1" });
    expect(() => parseTradeEvent("not-json")).toThrow();
    expect(() => parseTradeEvent(JSON.stringify({ type: "order", botId: "bot-1" }))).toThrow(/invalid/);
    expect(() => parseTradeEvent(JSON.stringify({ type: "fill", botId: "" }))).toThrow(/invalid/);
  });
});

describe("paper-only bot presentation", () => {
  const bot = (exchange: TradingBot["exchange"]): TradingBot => ({
    id: `${exchange}-bot`,
    name: "Bot",
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

  it("shows persisted live bots as stopped and blocks private runtime snapshots", () => {
    const live = bot("bybit");
    const presented = presentBotForRuntime(live, true);
    expect(presented.status).toBe("stopped");
    expect(live.status).toBe("running");
    expect(shouldLoadBotRuntime(live, true)).toBe(false);
  });

  it("keeps paper bots controllable and preserves legacy live presentation", () => {
    expect(presentBotForRuntime(bot("paper"), true).status).toBe("running");
    expect(shouldLoadBotRuntime(bot("paper"), true)).toBe(true);
    expect(presentBotForRuntime(bot("binance"), false).status).toBe("running");
  });
});
