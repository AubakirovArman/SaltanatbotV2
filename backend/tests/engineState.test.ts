import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fills: [] as Array<{ ts: number; realizedPnl: number; kind: "open" | "close" }>,
  settings: [] as Array<[string, unknown]>,
  positions: [] as unknown[],
  transactions: 0,
}));

vi.mock("../src/trading/store.js", () => ({
  listFills: () => structuredClone(state.fills),
  setSetting: (key: string, value: unknown) => state.settings.push([key, structuredClone(value)]),
  upsertPositionSnapshot: (value: unknown) => state.positions.push(structuredClone(value)),
  withStoreTransaction: <T>(operation: () => T) => {
    state.transactions += 1;
    return operation();
  },
}));

import { persistRuntimeState, realizedToday } from "../src/trading/engineState.js";
import type { RunningBot } from "../src/trading/engineRuntime.js";

beforeEach(() => {
  state.fills.length = 0;
  state.settings.length = 0;
  state.positions.length = 0;
  state.transactions = 0;
});

describe("durable engine state", () => {
  it("calculates daily loss only from confirmed durable fills in the current UTC day", () => {
    const day = 10 * 86_400_000;
    state.fills.push(
      { ts: day - 1, realizedPnl: -100, kind: "close" },
      { ts: day + 1, realizedPnl: -12.5, kind: "close" },
      { ts: day + 2, realizedPnl: 2.5, kind: "close" },
    );

    expect(realizedToday("bot", day + 1_000)).toBe(-10);
  });

  it("writes runtime state and its position snapshot in one store transaction", () => {
    const bot = {
      config: { id: "bot", symbol: "BTCUSDT", market: "spot", exchange: "binance" },
      vars: new Map([["count", 2]]),
      buffer: [{ time: 100 }],
      managed: { side: "long", entry: 90, qty: 0.25, entryTime: 50 },
    } as unknown as RunningBot;

    persistRuntimeState(bot, 200);

    expect(state.transactions).toBe(1);
    expect(state.settings).toEqual([["state:bot", expect.objectContaining({ vars: { count: 2 }, savedAt: 200 })]]);
    expect(state.positions).toEqual([expect.objectContaining({
      botId: "bot", symbol: "BTCUSDT", market: "spot", status: "open", updatedAt: 200,
    })]);
  });
});
