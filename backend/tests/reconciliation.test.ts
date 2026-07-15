import { describe, expect, it } from "vitest";
import { reconcileLiveRuntime } from "../src/trading/reconciliation.js";
import type { BotConfig, PendingOrder, PositionState } from "../src/trading/types.js";

const baseBot: BotConfig = {
  id: "bot",
  name: "bot",
  strategyName: "s",
  ir: { name: "s", inputs: [], body: [] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange: "bybit",
  market: "futures",
  sizeMode: "quote",
  sizeValue: 1000,
  leverage: 1,
  notifyMarkers: false,
  status: "running",
  createdAt: 1,
  updatedAt: 1
};

const longPosition: PositionState = {
  symbol: "BTCUSDT",
  side: "long",
  qty: 1,
  entryPrice: 100,
  leverage: 1,
  openedAt: 10
};

describe("live runtime reconciliation", () => {
  it("clears saved managed state when the exchange is flat", () => {
    const result = reconcileLiveRuntime({
      config: baseBot,
      savedManaged: { side: "long", entry: 100, qty: 1, entryTime: 10, stop: 95 },
      exchangePosition: null,
      openOrders: [],
      now: 20
    });

    expect(result.managed).toBeUndefined();
    expect(result.pause).toBe(false);
    expect(result.messages.join(" ")).toMatch(/cleared/i);
  });

  it("pauses a flat account when an orphan protection order remains", () => {
    const result = reconcileLiveRuntime({
      config: baseBot,
      exchangePosition: null,
      openOrders: [protectiveStop()],
      now: 20
    });

    expect(result).toMatchObject({ managed: undefined, pause: true });
    expect(result.messages.join(" ")).toMatch(/protection order.*flat.*cancel or reconcile/i);
  });

  it("adopts an exchange position and pauses when local runtime state is missing", () => {
    const result = reconcileLiveRuntime({
      config: baseBot,
      exchangePosition: longPosition,
      openOrders: [protectiveStop()],
      now: 20
    });

    expect(result.managed).toMatchObject({ side: "long", entry: 100, qty: 1 });
    expect(result.pause).toBe(true);
    expect(result.messages.join(" ")).toMatch(/no saved runtime state/i);
  });

  it("pauses an open futures position that has no visible protection", () => {
    const result = reconcileLiveRuntime({
      config: baseBot,
      savedManaged: { side: "long", entry: 100, qty: 1, entryTime: 10 },
      exchangePosition: longPosition,
      openOrders: [],
      now: 20
    });

    expect(result.pause).toBe(true);
    expect(result.messages.join(" ")).toMatch(/no visible local or exchange-side protection/i);
  });
});

function protectiveStop(): PendingOrder {
  return {
    id: "sl",
    symbol: "BTCUSDT",
    side: "sell",
    type: "stop_market",
    qty: 1,
    trgPrice: 95,
    reduceOnly: true,
    tif: "GTC",
    createdAt: 1
  };
}
