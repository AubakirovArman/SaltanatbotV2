import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, unknown>();
const fills = new Set<string>();
vi.mock("../src/trading/store.js", () => ({
  getSetting: (key: string) => structuredClone(settings.get(key)),
  setSetting: (key: string, value: unknown) => settings.set(key, structuredClone(value)),
  insertFill: (fill: { id: string }) => {
    if (fills.has(fill.id)) return false;
    fills.add(fill.id);
    return true;
  }
}));

import {
  applySpotFill,
  constrainSpotInventoryOrder,
  getSpotInventory,
  recordConfirmedFill,
  resolveSpotCloseQuantity
} from "../src/trading/spotInventory.js";
import type { ExecOrder, FillRecord } from "../src/trading/types.js";
import { applyFuturesExposure, getFuturesExposure } from "../src/trading/futuresExposure.js";

beforeEach(() => {
  settings.clear();
  fills.clear();
});

const fill = (overrides: Partial<FillRecord> = {}): FillRecord => ({
  id: "fill-1", botId: "bot", symbol: "BTCUSDT", side: "buy", qty: 0.25,
  price: 100, fee: 0.00025, feeAsset: "BTC", realizedPnl: 0, kind: "open",
  reason: "test", ts: 10, ...overrides
});

describe("bot-attributed spot inventory", () => {
  it("tracks base/quote fees, weighted average and remaining bot quantity", () => {
    const opened = applySpotFill(undefined, fill());
    expect(opened).toMatchObject({ baseAsset: "BTC", remainingQty: 0.24975, fees: { BTC: 0.00025 } });
    const added = applySpotFill(opened, fill({ id: "fill-2", qty: 0.25, price: 120, fee: 1, feeAsset: "USDT", ts: 11 }));
    expect(added.remainingQty).toBeCloseTo(0.49975);
    expect(added.avgPrice).toBeCloseTo((0.25 * 100 + 0.25 * 120 + 1) / 0.49975);
    const closed = applySpotFill(added, fill({ id: "fill-3", side: "sell", qty: 0.1, price: 130, fee: 0.2, feeAsset: "USDT", kind: "close", ts: 12 }));
    expect(closed.remainingQty).toBeCloseTo(0.39975);
    expect(closed.fees).toEqual({ BTC: 0.00025, USDT: 1.2 });
  });

  it("persists only deduplicated confirmed fills", () => {
    expect(recordConfirmedFill(fill(), "spot")).toBe(true);
    expect(recordConfirmedFill(fill(), "spot")).toBe(false);
    expect(getSpotInventory("bot", "BTCUSDT")?.remainingQty).toBeCloseTo(0.24975);
  });

  it("constrains closePct to this bot's inventory and refuses unattributed balance", () => {
    recordConfirmedFill(fill({ fee: 0, feeAsset: undefined }), "spot");
    const order: ExecOrder = { action: "neworder", market: "spot", symbol: "BTCUSDT", side: "sell", type: "market", closePct: 100, reduceOnly: true, reason: "close" };
    expect(constrainSpotInventoryOrder("bot", "spot", order)).toMatchObject({ action: "neworder", side: "sell", qty: 0.25, closePct: undefined });
    expect(constrainSpotInventoryOrder("bot", "spot", { ...order, action: "close", closePct: undefined })).toMatchObject({ action: "neworder", side: "sell", qty: 0.25 });
    expect(resolveSpotCloseQuantity(getSpotInventory("bot", "BTCUSDT"), 50)).toBe(0.125);
    expect(() => constrainSpotInventoryOrder("other", "spot", order)).toThrow(/no confirmed attributed inventory/i);
  });
});

describe("durable futures exposure ledger", () => {
  it("keeps accounted entry exposure visible while venue positions lag", () => {
    expect(recordConfirmedFill(fill({ fee: 0, feeAsset: undefined }), "futures")).toBe(true);
    expect(getFuturesExposure("bot", "BTCUSDT")?.grossQty).toBe(0.25);
    expect(recordConfirmedFill(fill({ fee: 0, feeAsset: undefined }), "futures")).toBe(false);
    const closed = applyFuturesExposure(getFuturesExposure("bot", "BTCUSDT"), fill({ id: "close", side: "sell", kind: "close", qty: 0.1 }));
    expect(closed.grossQty).toBeCloseTo(0.15);
  });
});
