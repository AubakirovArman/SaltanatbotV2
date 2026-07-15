import { describe, expect, it } from "vitest";
import { parseTradeEvent } from "./TradingView";

describe("trading event boundary", () => {
  it("accepts only known events with a bot identity", () => {
    expect(parseTradeEvent(JSON.stringify({ type: "bot", botId: "bot-1" }))).toMatchObject({ type: "bot", botId: "bot-1" });
    expect(() => parseTradeEvent("not-json")).toThrow();
    expect(() => parseTradeEvent(JSON.stringify({ type: "order", botId: "bot-1" }))).toThrow(/invalid/);
    expect(() => parseTradeEvent(JSON.stringify({ type: "fill", botId: "" }))).toThrow(/invalid/);
  });
});
