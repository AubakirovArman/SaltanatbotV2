import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end lifecycle test for the crash-safety fix: a bot's setvar counters and
 * managed-position state must survive a process restart (resume), and a bot that
 * resumes with stale risky state must PAUSE until an operator confirms.
 *
 * Uses the real TradingEngine + a fake market provider (canned candles pushed on
 * demand) + an in-memory store, so it exercises the true start/persist/resume
 * paths with zero network and no real database.
 */

vi.mock("../src/trading/store.js", () => {
  const bots = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    initStore: () => {},
    listBots: () => [...bots.values()].map((b) => clone(b)),
    upsertBot: (b: { id: string }) => bots.set(b.id, clone(b)),
    deleteBot: (id: string) => {
      bots.delete(id);
      settings.delete(`paper:${id}`);
      settings.delete(`state:${id}`);
    },
    deleteSetting: (k: string) => settings.delete(k),
    insertFill: () => {},
    listFills: () => [],
    insertLog: () => {},
    listLogs: () => [],
    getSetting: (k: string) => (settings.has(k) ? clone(settings.get(k)) : undefined),
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v)),
    __reset: () => {
      bots.clear();
      settings.clear();
    },
  };
});

import { TradingEngine } from "../src/trading/engine.js";
import * as store from "../src/trading/store.js";
import type { BotConfig } from "../src/trading/types.js";

const TF = 60_000;

// A stateful strategy: init count=0, then +1 every bar. No orders — pure state.
const counterIR = {
  name: "counter",
  inputs: [],
  init: [{ k: "setvar", name: "count", value: { k: "num", v: 0 } }],
  body: [{ k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } }],
};

function makeCandles(n: number, start: number) {
  return Array.from({ length: n }, (_, i) => ({ time: start + i * TF, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
}

function fakeProvider() {
  const start = Date.now() - 500 * TF; // seed ends ~now, so resume isn't "stale"
  const state: { push?: (c: unknown) => void } = {};
  return {
    provider: {
      name: "fake",
      async getCandles() {
        return makeCandles(500, start);
      },
      async subscribe(_i: unknown, _tf: unknown, onCandle: (c: unknown) => void) {
        state.push = onCandle;
        return { close() {} };
      },
    },
    lastSeedIndex: 499,
    pushBar(index: number) {
      state.push?.({ time: start + index * TF, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function baseConfig(id: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    id,
    name: id,
    strategyName: "s",
    ir: counterIR as unknown as BotConfig["ir"],
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "spot",
    sizeMode: "quote",
    sizeValue: 1000,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

afterEach(() => (store as unknown as { __reset: () => void }).__reset());

describe("engine lifecycle E2E", () => {
  it("persists setvar counters and restores them on resume (survives a crash)", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-counter");
    store.upsertBot(cfg);
    await engine.start(cfg);

    // init sets count=0; each pushed bar closes the previous one → count++.
    for (let k = 1; k <= 3; k += 1) {
      f.pushBar(f.lastSeedIndex + k);
      await flush();
    }
    expect(store.getSetting<{ vars: Record<string, number> }>(`state:${cfg.id}`)?.vars.count).toBe(3);

    // Simulate a crash: shutdown() keeps status "running" and persists state.
    engine.shutdown();

    // New process boots and resumes. Recent bars → not stale → not paused.
    const f2 = fakeProvider();
    const engine2 = new TradingEngine(f2.provider as never, () => {});
    await engine2.resume();
    expect(engine2.isPaused(cfg.id)).toBe(false);

    // Counter continues from 3, NOT reset to 0 (init does not re-run on resume).
    f2.pushBar(f2.lastSeedIndex + 1);
    await flush();
    expect(store.getSetting<{ vars: Record<string, number> }>(`state:${cfg.id}`)?.vars.count).toBe(4);
    engine2.shutdown();
  });

  it("pauses a bot resumed with stale risky state until an operator confirms", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-stale", { status: "running" });
    store.upsertBot(cfg);
    // A nonzero counter persisted 100 days ago — resuming and trading blindly would
    // be dangerous, so the bot must come back PAUSED.
    store.setSetting(`state:${cfg.id}`, {
      vars: { count: 5 },
      lastBarTime: Date.now() - 100 * 24 * 3600 * 1000,
      savedAt: Date.now(),
    });

    await engine.resume();
    expect(engine.isPaused(cfg.id)).toBe(true);
    expect(engine.confirmResume(cfg.id)).toBe(true);
    expect(engine.isPaused(cfg.id)).toBe(false);
    engine.shutdown();
  });
});
