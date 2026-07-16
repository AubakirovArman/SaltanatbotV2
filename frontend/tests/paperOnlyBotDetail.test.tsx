// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { tradingText } from "../src/i18n/trading";
import { BotDetail } from "../src/trading/components/BotDetail";
import type { TradingBot } from "../src/trading/tradeClient";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("paper-only live bot details", () => {
  it("shows a disabled marker without start, resume or command controls", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const bot: TradingBot = {
      id: "legacy-live",
      name: "Legacy live bot",
      strategyName: "Strategy",
      ir: {} as TradingBot["ir"],
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange: "bybit",
      market: "futures",
      sizeMode: "quote",
      sizeValue: 100,
      leverage: 1,
      notifyMarkers: false,
      status: "stopped",
      createdAt: 1,
      updatedAt: 1
    };

    await act(async () => {
      root.render(<BotDetail bot={bot} orders={[]} orderJournal={[]} fills={[]} logs={[]} locale="en" canControl executionDisabled onChanged={() => {}} onDeleted={() => {}} />);
    });

    expect(container.textContent).toContain(tradingText("en", "liveExecutionDisabled"));
    expect(container.querySelector(".trade-detail-actions")).toBeNull();
    expect(container.querySelector(".trade-console")).toBeNull();
    expect(container.querySelector(".order-cancel")).toBeNull();
    await act(async () => root.unmount());
  });
});
