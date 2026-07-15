import { describe, expect, it } from "vitest";
import { findLiveCollision } from "../src/trading/collision.js";
import type { BotConfig } from "../src/trading/types.js";

/**
 * Two live bots on the same exchange+symbol fight: one's close flattens the
 * shared position and its cancelAll cancels the other's orders. `start()` blocks
 * this via findLiveCollision unless an explicit override is passed. Paper bots
 * are isolated sims and are exempt.
 */

function bot(overrides: Partial<BotConfig>): BotConfig {
  return {
    id: overrides.id ?? "id",
    name: overrides.name ?? "Bot",
    strategyName: "Strategy",
    ir: {} as BotConfig["ir"],
    symbol: overrides.symbol ?? "BTCUSDT",
    timeframe: "1m",
    exchange: overrides.exchange ?? "binance",
    market: overrides.market ?? "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "running",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

describe("findLiveCollision", () => {
  it("flags another live bot on the same exchange+symbol", () => {
    const running = [bot({ id: "a", exchange: "binance", symbol: "BTCUSDT" })];
    const clash = findLiveCollision(bot({ id: "b", exchange: "binance", symbol: "BTCUSDT" }), running);
    expect(clash?.id).toBe("a");
  });

  it("does not flag a different symbol", () => {
    const running = [bot({ id: "a", exchange: "binance", symbol: "ETHUSDT" })];
    expect(findLiveCollision(bot({ id: "b", exchange: "binance", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("does not flag a different exchange", () => {
    const running = [bot({ id: "a", exchange: "bybit", symbol: "BTCUSDT" })];
    expect(findLiveCollision(bot({ id: "b", exchange: "binance", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("does not collide across explicitly different account ids", () => {
    const running = [bot({ id: "a", exchange: "binance", accountId: "account-a", symbol: "BTCUSDT" })];
    expect(findLiveCollision(bot({ id: "b", exchange: "binance", accountId: "account-b", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("ignores the bot itself (restart on same id)", () => {
    const running = [bot({ id: "a", exchange: "binance", symbol: "BTCUSDT" })];
    expect(findLiveCollision(bot({ id: "a", exchange: "binance", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("exempts the incoming paper bot", () => {
    const running = [bot({ id: "a", exchange: "binance", symbol: "BTCUSDT" })];
    expect(findLiveCollision(bot({ id: "b", exchange: "paper", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("ignores a running paper bot on the same symbol", () => {
    const running = [bot({ id: "a", exchange: "paper", symbol: "BTCUSDT" })];
    expect(findLiveCollision(bot({ id: "b", exchange: "binance", symbol: "BTCUSDT" }), running)).toBeUndefined();
  });

  it("distinguishes spot vs futures markets only by exchange+symbol", () => {
    // Same exchange+symbol on different markets still collide (same account, same symbol).
    const running = [bot({ id: "a", exchange: "binance", symbol: "BTCUSDT", market: "spot" })];
    const clash = findLiveCollision(bot({ id: "b", exchange: "binance", symbol: "BTCUSDT", market: "futures" }), running);
    expect(clash?.id).toBe("a");
  });
});
