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
  const orders = new Map<string, unknown>();
  const orderEvents: unknown[] = [];
  const fills = new Set<string>();
  const paperEvents = new Map<string, { id: string; botId: string; sequence: number }>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    initStore: () => {},
    listBots: () => [...bots.values()].map((b) => clone(b)),
    upsertBot: (b: { id: string }) => bots.set(b.id, clone(b)),
    deleteBot: (id: string) => {
      bots.delete(id);
      settings.delete(`paper:${id}`);
      settings.delete(`state:${id}`);
      for (const [eventId, event] of paperEvents) if (event.botId === id) paperEvents.delete(eventId);
    },
    deleteSetting: (k: string) => settings.delete(k),
    insertFill: (fill: { id: string }) => {
      if (fills.has(fill.id)) return false;
      fills.add(fill.id);
      return true;
    },
    withStoreTransaction: <T>(operation: () => T) => operation(),
    listFills: () => [],
    upsertPositionSnapshot: () => {},
    upsertOrderJournal: (order: { id: string }) => orders.set(order.id, clone(order)),
    getOrderJournal: (id: string) => (orders.has(id) ? clone(orders.get(id)) : undefined),
    insertOrderEvent: (event: unknown) => orderEvents.push(clone(event)),
    listOrderJournal: (botId: string, limit = 200) =>
      [...orders.values()]
        .map((item) => clone(item as { botId: string; updatedAt: number }))
        .filter((item) => item.botId === botId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit),
    listRiskOrderJournal: (botId: string, limit = 1_001) =>
      [...orders.values()]
        .map((item) => clone(item as { botId: string; status: string; updatedAt: number; action: string }))
        .filter((item) => item.botId === botId && ["intent", "accepted", "partially_filled", "unknown"].includes(item.status))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit),
    listExecutionReconciliationJournal: (botId: string, limit = 1_001) =>
      [...orders.values()]
        .map((item) => clone(item as { botId: string; status: string; updatedAt: number; filledQty?: number; accountedFilledQty?: number }))
        .filter(
          (item) =>
            item.botId === botId &&
            (["intent", "accepted", "partially_filled", "unknown"].includes(item.status) || (["filled", "replaced"].includes(item.status) && item.filledQty !== item.accountedFilledQty) || (["cancelled", "expired", "rejected"].includes(item.status) && (item.filledQty ?? 0) > (item.accountedFilledQty ?? 0)))
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit),
    listOrderEvents: (orderId: string, limit = 200) =>
      orderEvents
        .map((item) => clone(item as { orderId: string; ts: number }))
        .filter((item) => item.orderId === orderId)
        .sort((left, right) => left.ts - right.ts)
        .slice(0, limit),
    appendPaperLedgerEvents: (events: Array<{ id: string; botId: string; sequence: number }>) => {
      let inserted = 0;
      for (const event of events) {
        const prior = paperEvents.get(event.id);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(event)) throw new Error(`Conflicting paper event ${event.id}`);
          continue;
        }
        paperEvents.set(event.id, clone(event));
        inserted += 1;
      }
      return inserted;
    },
    listPaperLedgerEvents: (botId: string) =>
      [...paperEvents.values()]
        .filter((event) => event.botId === botId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => clone(event)),
    insertLog: () => {},
    listLogs: () => [],
    getSetting: (k: string) => {
      if (k === "keys:binance" || k === "keys:bybit") return { apiKey: "test-api-key", apiSecret: "test-api-secret" };
      return settings.has(k) ? clone(settings.get(k)) : undefined;
    },
    getTradingAccount: (id: string) => {
      const exchange = id === "binance:default" ? "binance" : id === "bybit:default" ? "bybit" : undefined;
      return exchange ? { id, label: `${exchange} test`, exchange, ownership: "own", enabled: true, createdAt: 1, updatedAt: 1 } : undefined;
    },
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v)),
    __reset: () => {
      bots.clear();
      settings.clear();
      orders.clear();
      orderEvents.length = 0;
      fills.clear();
      paperEvents.clear();
    },
    __orders: () => [...orders.values()].map((item) => clone(item)),
    __orderEvents: () => orderEvents.map((item) => clone(item))
  };
});

import { TradingEngine } from "../src/trading/engine.js";
import type { RunningBot } from "../src/trading/engineRuntime.js";
import * as store from "../src/trading/store.js";
import type { BotConfig, ExchangeOrderSnapshot } from "../src/trading/types.js";

const TF = 60_000;

// A stateful strategy: init count=0, then +1 every bar. No orders — pure state.
const counterIR = {
  name: "counter",
  inputs: [],
  init: [{ k: "setvar", name: "count", value: { k: "num", v: 0 } }],
  body: [{ k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } }]
};

const entryIR = {
  name: "entry",
  inputs: [],
  body: [
    { k: "entry", direction: "long", when: { k: "bool", v: true } },
    { k: "size", mode: "units", value: { k: "num", v: 1 } }
  ]
};

function makeCandles(n: number, start: number) {
  return Array.from({ length: n }, (_, i) => ({ time: start + i * TF, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
}

function fakeProvider() {
  const start = Date.now() - 500 * TF; // seed ends ~now, so resume isn't "stale"
  const state: { push?: (c: unknown) => void; candleOptions?: unknown; subscribeOptions?: unknown } = {};
  return {
    provider: {
      name: "fake",
      async getCandles(_instrument: unknown, _timeframe: unknown, _range: unknown, options?: unknown) {
        state.candleOptions = options;
        return makeCandles(500, start);
      },
      async subscribe(_i: unknown, _tf: unknown, onCandle: (c: unknown) => void, _onStatus?: unknown, options?: unknown) {
        state.subscribeOptions = options;
        state.push = onCandle;
        return { close() {} };
      },
      async subscribeMarket(_i: unknown, _tf: unknown, onEvent: (event: { candle: unknown }) => void, _onStatus?: unknown, options?: unknown) {
        state.subscribeOptions = options;
        state.push = (candle) => onEvent({ candle });
        return { close() {} };
      }
    },
    options: state,
    lastSeedIndex: 499,
    pushBar(index: number) {
      state.push?.({ time: start + index * TF, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }
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
    maxPositionQuote: 5_000,
    maxOrderQuote: 1_000,
    maxDailyLossQuote: 500,
    maxOpenOrders: 10,
    notifyMarkers: false,
    status: "stopped",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over
  };
}

afterEach(() => (store as unknown as { __reset: () => void }).__reset());

describe("engine lifecycle E2E", () => {
  it("serializes concurrent live starts on the same account instrument", async () => {
    const f = fakeProvider();
    const originalGetCandles = f.provider.getCandles.bind(f.provider);
    let calls = 0;
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    f.provider.getCandles = async (...args: Parameters<typeof originalGetCandles>) => {
      calls += 1;
      if (calls === 1) await firstGate;
      return originalGetCandles(...args);
    };
    const engine = new TradingEngine(f.provider as never, () => {});
    const first = engine.start(baseConfig("live-start-1", { exchange: "bybit", market: "futures" }));
    while (calls === 0) await Promise.resolve();
    const second = engine.start(baseConfig("live-start-2", { exchange: "bybit", market: "futures" }));
    const secondAssertion = expect(second).rejects.toThrow(/already running/i);

    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await first;
    await secondAssertion;
    expect(calls).toBe(1);
    engine.shutdown();
  });

  it("releases the live-start lock after startup fails", async () => {
    const f = fakeProvider();
    const originalGetCandles = f.provider.getCandles.bind(f.provider);
    let calls = 0;
    f.provider.getCandles = async (...args: Parameters<typeof originalGetCandles>) => {
      calls += 1;
      if (calls === 1) throw new Error("seed unavailable");
      return originalGetCandles(...args);
    };
    const engine = new TradingEngine(f.provider as never, () => {});

    await expect(engine.start(baseConfig("failed-live-start", { exchange: "bybit", market: "futures" }))).rejects.toThrow("seed unavailable");
    await expect(engine.start(baseConfig("retry-live-start", { exchange: "bybit", market: "futures" }))).resolves.toBeUndefined();
    expect(calls).toBe(2);
    engine.shutdown();
  });

  it("serializes same-id starts across different instrument keys without leaking a subscription", async () => {
    const f = fakeProvider();
    const originalGetCandles = f.provider.getCandles.bind(f.provider);
    let seedCalls = 0;
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    f.provider.getCandles = async (...args: Parameters<typeof originalGetCandles>) => {
      seedCalls += 1;
      if (seedCalls === 1) await firstGate;
      return originalGetCandles(...args);
    };
    let subscriptions = 0;
    let closes = 0;
    f.provider.subscribeMarket = vi.fn(async () => {
      subscriptions += 1;
      return {
        close: () => {
          closes += 1;
        }
      };
    });
    const engine = new TradingEngine(f.provider as never, () => {});
    const first = engine.start(baseConfig("same-id-race", { exchange: "bybit", market: "futures" }));
    while (seedCalls === 0) await Promise.resolve();
    const second = engine.start(baseConfig("same-id-race", { exchange: "bybit", market: "futures", symbol: "ETHUSDT" }));
    await flush();
    expect(seedCalls).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(seedCalls).toBe(1);
    expect(subscriptions).toBe(1);
    engine.shutdown();
    expect(closes).toBe(1);
  });

  it("blocks risk-increasing commands while paused but permits cancellation and reduce-only fills", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("paused-command-gate", { market: "futures" });
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    runtime.paused = true;
    runtime.pauseReason = "test gate";
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1 };
    runtime.adapter.execute = vi.fn(async (order) => {
      if (order.action === "cancelall") return { ok: true, message: "cancelled", fills: [] };
      return {
        ok: true,
        message: "filled",
        fills: [
          {
            id: `fill-${order.action}`,
            botId: cfg.id,
            symbol: cfg.symbol,
            side: "sell" as const,
            qty: 0.4,
            price: 100,
            fee: 0,
            realizedPnl: 0,
            kind: "close" as const,
            clientId: order.clientId,
            reason: "test",
            ts: 2
          }
        ]
      };
    });

    await expect(engine.manualCommand(cfg.id, "action=openposition;side=buy;qty=1")).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/paused/i) });
    expect(runtime.adapter.execute).not.toHaveBeenCalled();
    await expect(engine.manualCommand(cfg.id, "action=cancelall")).resolves.toMatchObject({ ok: true });
    await expect(engine.manualCommand(cfg.id, "action=closeposition;qty=0.4")).resolves.toMatchObject({ ok: true });
    expect(runtime.managed?.qty).toBeCloseTo(0.6);
    expect(runtime.paused).toBe(true);
    engine.shutdown();
  });

  it("does not ratchet stops or submit exits from onTick while paused", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("paused-tick", { market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as { running: Map<string, RunningBot>; onTick(bot: RunningBot, candle: ReturnType<typeof makeCandles>[number]): Promise<void> };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    runtime.paused = true;
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1, stop: 90, target: 110, trail: { mode: "percent", value: 5 } };
    runtime.adapter.execute = vi.fn(runtime.adapter.execute.bind(runtime.adapter));

    await internal.onTick(runtime, { time: 2, open: 100, high: 200, low: 50, close: 100, volume: 1 });

    expect(runtime.managed).toMatchObject({ stop: 90, target: 110 });
    expect(runtime.adapter.execute).not.toHaveBeenCalled();
    engine.shutdown();
  });

  it("pauses and preserves managed state when a live manual close is only acknowledged", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("manual-close-ack", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1, stop: 90 };
    runtime.adapter.execute = vi.fn(async () => ({ ok: true, message: "close accepted", fills: [] }));

    await expect(engine.manualCommand(cfg.id, "action=closeposition")).resolves.toEqual({ ok: true, message: "close accepted" });

    expect(runtime.managed?.qty).toBe(1);
    expect(runtime.paused).toBe(true);
    expect(store.getSetting<{ paused?: boolean; managed?: { qty: number } }>(`state:${cfg.id}`)).toMatchObject({ paused: true, managed: { qty: 1 } });
    expect((store as unknown as { __orders: () => Array<{ reduceOnly?: boolean }> }).__orders().at(-1)?.reduceOnly).toBe(true);
    engine.shutdown();
  });

  it("pauses and persists a live transport-unknown order while paper remains resumable", async () => {
    const liveFeed = fakeProvider();
    const liveEngine = new TradingEngine(liveFeed.provider as never, () => {});
    const live = baseConfig("manual-transport-unknown", { exchange: "bybit", market: "futures" });
    await liveEngine.start(live);
    const liveRuntime = (liveEngine as unknown as { running: Map<string, RunningBot> }).running.get(live.id);
    if (!liveRuntime) throw new Error("running bot missing");
    if (liveRuntime.orderPollTimer) clearInterval(liveRuntime.orderPollTimer);
    liveRuntime.adapter.price = vi.fn(async () => 100);
    liveRuntime.adapter.orders = vi.fn(async () => []);
    liveRuntime.adapter.positions = vi.fn(async () => []);
    liveRuntime.adapter.execute = vi.fn(async () => {
      throw new Error("transport timeout");
    });

    await expect(liveEngine.manualCommand(live.id, "action=openposition;side=buy;qty=1")).resolves.toEqual({ ok: false, message: "transport timeout" });
    expect(liveRuntime.paused).toBe(true);
    expect(store.getSetting<{ paused?: boolean; pauseReason?: string }>(`state:${live.id}`)).toMatchObject({
      paused: true,
      pauseReason: expect.stringMatching(/outcome is unknown/i)
    });
    expect((store as unknown as { __orders: () => Array<{ status: string }> }).__orders().at(-1)?.status).toBe("unknown");
    await expect(liveEngine.manualCommand(live.id, "action=openposition;side=buy;qty=1")).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/paused/i) });
    expect(liveRuntime.adapter.execute).toHaveBeenCalledTimes(1);
    liveEngine.shutdown();

    (store as unknown as { __reset: () => void }).__reset();
    const paperFeed = fakeProvider();
    const paperEngine = new TradingEngine(paperFeed.provider as never, () => {});
    const paper = baseConfig("paper-transport-error", { market: "futures" });
    await paperEngine.start(paper);
    const paperRuntime = (paperEngine as unknown as { running: Map<string, RunningBot> }).running.get(paper.id);
    if (!paperRuntime) throw new Error("running paper bot missing");
    paperRuntime.adapter.execute = vi.fn(async () => {
      throw new Error("paper adapter failed");
    });
    await expect(paperEngine.manualCommand(paper.id, "action=openposition;side=buy;qty=1")).resolves.toEqual({ ok: false, message: "paper adapter failed" });
    expect(paperRuntime.paused).not.toBe(true);
    paperEngine.shutdown();
  });

  it("pauses a strategy after an ambiguous live submit and does not retry on the next bar", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("strategy-transport-unknown", { exchange: "bybit", market: "futures", ir: entryIR as unknown as BotConfig["ir"] });
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.adapter.account = vi.fn(async () => ({ balance: 1_000, equity: 1_000, currency: "USDT" }));
    runtime.adapter.price = vi.fn(async () => 100);
    runtime.adapter.orders = vi.fn(async () => []);
    runtime.adapter.positions = vi.fn(async () => []);
    runtime.adapter.execute = vi.fn(async () => {
      throw new Error("connection reset after send");
    });

    f.pushBar(f.lastSeedIndex + 1);
    await runtime.eventQueue;
    expect(runtime.paused).toBe(true);
    expect((store as unknown as { __orders: () => Array<{ status: string }> }).__orders().at(-1)?.status).toBe("unknown");
    f.pushBar(f.lastSeedIndex + 2);
    await runtime.eventQueue;
    expect(runtime.adapter.execute).toHaveBeenCalledTimes(1);
    engine.shutdown();
  });

  it("fails closed on an invalid synchronous live fill and preserves managed state", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("sync-fill-accounting", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as {
      running: Map<string, RunningBot>;
      applyResult(bot: RunningBot, result: { ok: boolean; message: string; fills: Array<Record<string, unknown>> }, reason: string, order: Record<string, unknown>): { changed: boolean; pauseReason?: string };
    };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1 };
    const submitted = {
      action: "close",
      market: "futures",
      symbol: cfg.symbol,
      side: "sell",
      type: "market",
      qty: 1,
      reduceOnly: true,
      reason: "test",
      clientId: "sync-close-client"
    };
    store.upsertOrderJournal({
      id: "sync-close-client",
      botId: cfg.id,
      exchange: "bybit",
      market: "futures",
      symbol: cfg.symbol,
      action: "close",
      side: "sell",
      type: "market",
      qty: 1,
      reduceOnly: true,
      reason: "test",
      clientId: "sync-close-client",
      status: "filled",
      filledQty: 1,
      ts: 1,
      updatedAt: 1
    });
    const invalidFill = {
      id: "sync-invalid-fill",
      botId: cfg.id,
      symbol: cfg.symbol,
      side: "sell",
      qty: 1,
      price: 100,
      fee: 0,
      realizedPnl: 0,
      kind: "close",
      reason: "test",
      clientId: "wrong-client",
      ts: 2
    };

    const outcome = internal.applyResult(runtime, { ok: true, message: "filled", fills: [invalidFill] }, "test", submitted);

    expect(outcome.pauseReason).toMatch(/could not cross durable accounting/i);
    expect(runtime.paused).toBe(true);
    expect(runtime.managed?.qty).toBe(1);
    expect(store.getSetting<{ paused?: boolean }>(`state:${cfg.id}`)?.paused).toBe(true);
    engine.shutdown();
  });

  it("executes live GET without creating an eternal accepted order journal row", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("read-without-journal", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.adapter.execute = vi.fn(async () => ({ ok: true, message: "position read", fills: [], data: { position: null } }));

    await expect(engine.manualCommand(cfg.id, "get=POSITION")).resolves.toEqual({ ok: true, message: "position read" });

    expect((store as unknown as { __orders: () => unknown[] }).__orders()).toEqual([]);
    engine.shutdown();
  });

  it("immediately persists a pause when a private stream reports an unaccounted terminal order", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("terminal-private-fill", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as {
      running: Map<string, RunningBot>;
      orderCoordinator: { startPrivateOrderStream(bot: RunningBot): void };
    };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    let onSnapshot: ((snapshot: ExchangeOrderSnapshot) => void) | undefined;
    runtime.adapter.subscribeOrderUpdates = async (listener) => {
      onSnapshot = listener;
      return { close() {}, connected: () => true };
    };
    internal.orderCoordinator.startPrivateOrderStream(runtime);
    await flush();
    expect(runtime.privateOrderSubscription?.connected()).toBe(true);

    store.upsertOrderJournal({
      id: "private-terminal-order",
      botId: cfg.id,
      exchange: "bybit",
      market: "futures",
      symbol: cfg.symbol,
      action: "open",
      side: "buy",
      type: "market",
      qty: 1,
      reduceOnly: false,
      reason: "test",
      clientId: "private-terminal-client",
      status: "accepted",
      reservedOpenOrderCount: 1,
      ts: 1,
      updatedAt: 1
    });
    onSnapshot?.({
      id: "private-terminal-venue",
      clientId: "private-terminal-client",
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 100,
      updatedAt: 2
    });
    await runtime.eventQueue;

    expect(engine.isPaused(cfg.id)).toBe(true);
    expect(store.getSetting<{ paused?: boolean; pauseReason?: string }>(`state:${cfg.id}`)).toMatchObject({
      paused: true,
      pauseReason: expect.stringMatching(/without authenticated execution accounting/i)
    });
    engine.shutdown();
  });

  it("fails closed on an unmatched authenticated private execution", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("unmatched-private-fill", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as { running: Map<string, RunningBot>; orderCoordinator: { startPrivateOrderStream(bot: RunningBot): void } };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    let onSnapshot: ((snapshot: ExchangeOrderSnapshot) => void) | undefined;
    runtime.adapter.subscribeOrderUpdates = async (listener) => {
      onSnapshot = listener;
      return { close() {}, connected: () => true };
    };
    internal.orderCoordinator.startPrivateOrderStream(runtime);
    await flush();

    expect(() =>
      onSnapshot?.({
        id: "unknown-venue-order",
        status: "filled",
        qty: 1,
        filledQty: 1,
        updatedAt: 2,
        execution: { id: "unmatched-execution", qty: 1, price: 100, fee: 0, realizedPnl: 0, ts: 2 }
      })
    ).not.toThrow();
    await runtime.eventQueue;

    expect(runtime.paused).toBe(true);
    expect(store.getSetting<{ pauseReason?: string }>(`state:${cfg.id}`)?.pauseReason).toMatch(/could not be matched/i);
    engine.shutdown();
  });

  it("fails closed without rebinding or accounting a private execution with conflicting client identity", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("conflicting-private-fill", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as { running: Map<string, RunningBot>; orderCoordinator: { startPrivateOrderStream(bot: RunningBot): void } };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    let onSnapshot: ((snapshot: ExchangeOrderSnapshot) => void) | undefined;
    runtime.adapter.subscribeOrderUpdates = async (listener) => {
      onSnapshot = listener;
      return { close() {}, connected: () => true };
    };
    internal.orderCoordinator.startPrivateOrderStream(runtime);
    await flush();

    store.upsertOrderJournal({
      id: "conflicting-private-order",
      botId: cfg.id,
      exchange: "bybit",
      market: "futures",
      symbol: cfg.symbol,
      action: "open",
      side: "buy",
      type: "market",
      qty: 1,
      reduceOnly: false,
      reason: "test",
      clientId: "managed-client",
      exchangeOrderId: "managed-venue-order",
      status: "accepted",
      reservedOpenOrderCount: 1,
      ts: 1,
      updatedAt: 1
    });
    const conflictingSnapshot: ExchangeOrderSnapshot = {
      id: "managed-venue-order",
      clientId: "foreign-client",
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 100,
      updatedAt: 2,
      execution: { id: "conflicting-execution", qty: 1, price: 100, fee: 0, realizedPnl: 0, side: "buy", ts: 2 }
    };

    onSnapshot?.(conflictingSnapshot);
    await runtime.eventQueue;
    onSnapshot?.(conflictingSnapshot); // reconnect/restart replay remains fail-closed and idempotent
    await runtime.eventQueue;

    expect(runtime.paused).toBe(true);
    expect(runtime.pauseReason).toMatch(/conflicts with durable order identity/i);
    expect(store.getSetting<{ paused?: boolean; pauseReason?: string }>(`state:${cfg.id}`)).toMatchObject({
      paused: true,
      pauseReason: expect.stringMatching(/conflicts with durable order identity/i)
    });
    const persisted = (store as unknown as { __orders: () => Array<{ clientId?: string; status: string; filledQty?: number; accountedFilledQty?: number }> }).__orders().find((record) => record.clientId === "managed-client");
    expect(persisted).toMatchObject({
      clientId: "managed-client",
      status: "accepted"
    });
    expect(persisted?.filledQty).toBeUndefined();
    expect(persisted?.accountedFilledQty).toBeUndefined();
    expect((store as unknown as { __orderEvents: () => Array<{ type?: string }> }).__orderEvents().filter((event) => event.type === "fill")).toHaveLength(0);

    engine.shutdown();
    expect(store.getSetting<{ paused?: boolean }>(`state:${cfg.id}`)).toMatchObject({ paused: true });
  });

  it("accounts a private reduce-only fill, preserves state on position-read failure, then requires fresh confirmation", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("private-reduce-reconcile", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const internal = engine as unknown as { running: Map<string, RunningBot>; orderCoordinator: { startPrivateOrderStream(bot: RunningBot): void } };
    const runtime = internal.running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1, stop: 90 };
    const position = vi.fn().mockRejectedValueOnce(new Error("position unavailable")).mockResolvedValueOnce(null);
    runtime.adapter.position = position;
    runtime.adapter.orders = vi.fn(async () => []);
    let onSnapshot: ((snapshot: ExchangeOrderSnapshot) => void) | undefined;
    runtime.adapter.subscribeOrderUpdates = async (listener) => {
      onSnapshot = listener;
      return { close() {}, connected: () => true };
    };
    internal.orderCoordinator.startPrivateOrderStream(runtime);
    await flush();
    store.upsertOrderJournal({
      id: "private-close",
      botId: cfg.id,
      exchange: "bybit",
      market: "futures",
      symbol: cfg.symbol,
      action: "close",
      side: "sell",
      type: "market",
      qty: 1,
      reduceOnly: true,
      reason: "test",
      clientId: "private-close-client",
      status: "accepted",
      reservedOpenOrderCount: 1,
      ts: 1,
      updatedAt: 1
    });
    onSnapshot?.({
      id: "private-close-venue",
      clientId: "private-close-client",
      status: "filled",
      qty: 1,
      filledQty: 1,
      avgFillPrice: 100,
      updatedAt: 2,
      execution: { id: "private-close-execution", qty: 1, price: 100, fee: 0, realizedPnl: 2, side: "sell", ts: 2 }
    });
    await runtime.eventQueue;

    expect(runtime.paused).toBe(true);
    expect(runtime.managed?.qty).toBe(1);
    expect(runtime.pauseReason).toMatch(/position unavailable/i);
    expect(await engine.confirmResume(cfg.id)).toBe(true);
    expect(position).toHaveBeenCalledTimes(2);
    expect(runtime.managed).toBeUndefined();
    expect(runtime.paused).toBe(false);
    engine.shutdown();
  });

  it("refuses live resume confirmation while a reduce-only child outcome is unresolved", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("confirm-child-exit", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    if (runtime.orderPollTimer) clearInterval(runtime.orderPollTimer);
    runtime.paused = true;
    runtime.pauseReason = "operator check";
    runtime.managed = { side: "long", entry: 100, qty: 1, entryTime: 1, stop: 90 };
    runtime.adapter.orders = vi.fn(async () => []);
    runtime.adapter.orderStatus = vi.fn(async () => null);
    runtime.adapter.position = vi.fn(async () => ({ symbol: cfg.symbol, side: "long", qty: 1, entryPrice: 100, leverage: 1, openedAt: 1 }));
    store.upsertOrderJournal({
      id: "child-safety-close",
      botId: cfg.id,
      exchange: "bybit",
      market: "futures",
      symbol: cfg.symbol,
      action: "close",
      side: "sell",
      type: "market",
      qty: 1,
      reduceOnly: true,
      reason: "protection:safety_close",
      clientId: "child-safety-client",
      status: "accepted",
      reservedOpenOrderCount: 1,
      ts: 1,
      updatedAt: 1
    });

    expect(await engine.confirmResume(cfg.id)).toBe(false);
    expect(runtime.paused).toBe(true);
    expect(runtime.pauseReason).toMatch(/execution outcome.*unaccounted/i);
    expect(runtime.adapter.orders).toHaveBeenCalledWith(cfg.symbol);
    expect(runtime.adapter.position).toHaveBeenCalledWith(cfg.symbol);
    engine.shutdown();
  });

  it("serializes concurrent manual command sets before the next exchange submit", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-manual-lock");
    store.upsertBot(cfg);
    await engine.start(cfg);

    const runtime = (engine as unknown as { running: Map<string, { adapter: { execute: (order: unknown) => Promise<unknown> } }> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    let calls = 0;
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtime.adapter.execute = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return { ok: true, message: `submitted-${calls}`, fills: [] };
    });

    const first = engine.manualCommand(cfg.id, "action=openposition;symbol=BTCUSDT;qty=1");
    while (calls === 0) await Promise.resolve();
    const second = engine.manualCommand(cfg.id, "action=openposition;symbol=BTCUSDT;qty=1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, message: "submitted-1" },
      { ok: true, message: "submitted-2" }
    ]);
    expect(calls).toBe(2);
    engine.shutdown();
  });

  it("drains an in-flight command before an interactive stop completes", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-safe-stop");
    await engine.start(cfg);
    const runtime = (engine as unknown as { running: Map<string, RunningBot> }).running.get(cfg.id);
    if (!runtime) throw new Error("running bot missing");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.adapter.execute = vi.fn(async () => {
      await gate;
      return { ok: true, message: "submitted", fills: [] };
    });

    const command = engine.manualCommand(cfg.id, "get=POSITION");
    while (!vi.mocked(runtime.adapter.execute).mock.calls.length) await Promise.resolve();
    const stopped = engine.stopSafely(cfg.id);
    await flush();
    expect(engine.isRunning(cfg.id)).toBe(true);

    release();
    await expect(command).resolves.toEqual({ ok: true, message: "submitted" });
    await stopped;
    expect(engine.isRunning(cfg.id)).toBe(false);
  });

  it("reconciles venue state when a live bot is manually started after a stop", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-manual-live-restart", { exchange: "bybit", market: "futures" });
    await engine.start(cfg);
    await engine.stopSafely(cfg.id);

    const coordinator = (
      engine as unknown as {
        orderCoordinator: { reconcileOnResume: (bot: RunningBot) => Promise<boolean> };
      }
    ).orderCoordinator;
    const reconcile = vi.spyOn(coordinator, "reconcileOnResume").mockResolvedValue(false);

    await engine.start(cfg);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0].config.id).toBe(cfg.id);
    engine.shutdown();
  });

  it("persists strategy order intent/result/fill events to the order journal", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-journal", { ir: entryIR as unknown as BotConfig["ir"] });
    store.upsertBot(cfg);
    await engine.start(cfg);

    f.pushBar(f.lastSeedIndex + 1);
    await flush();

    const orders = (store as unknown as { __orders: () => Array<{ status: string; clientId?: string; accountedFilledQty?: number }> }).__orders();
    const events = (store as unknown as { __orderEvents: () => Array<{ type: string; orderId: string }> }).__orderEvents();
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("filled");
    expect(orders[0].accountedFilledQty).toBe(1);
    expect(orders[0].clientId).toMatch(/e2e-jour-o-/);
    expect(events.map((event) => event.type)).toEqual(["intent", "result", "fill"]);
    expect(new Set(events.map((event) => event.orderId)).size).toBe(1);
    engine.shutdown();
  });

  it("routes live Bybit futures market data through the Bybit linear feed", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-bybit-route", { exchange: "bybit", market: "futures" });

    await engine.start(cfg, { override: true });

    expect(f.options.candleOptions).toMatchObject({ exchange: "bybit", marketType: "linear", priceType: "last", strict: true });
    expect(f.options.subscribeOptions).toMatchObject({ exchange: "bybit", marketType: "linear", priceType: "last", strict: true });
    engine.shutdown();
  });

  it("evaluates one closed bar only once when duplicate websocket updates arrive while processing", async () => {
    const f = fakeProvider();
    const engine = new TradingEngine(f.provider as never, () => {});
    const cfg = baseConfig("e2e-serial-candle");
    store.upsertBot(cfg);
    await engine.start(cfg);

    f.pushBar(f.lastSeedIndex + 1);
    f.pushBar(f.lastSeedIndex + 1);
    await flush();

    expect(store.getSetting<{ vars: Record<string, number> }>(`state:${cfg.id}`)?.vars.count).toBe(1);
    engine.shutdown();
  });

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
      savedAt: Date.now()
    });

    await engine.resume();
    expect(engine.isPaused(cfg.id)).toBe(true);
    const pausedState = await engine.liveState(cfg.id);
    expect(pausedState?.runtimeStatus).toBe("requires_manual_action");
    expect(pausedState?.pauseReason).toMatch(/stale state/i);
    expect(store.getSetting<{ paused?: boolean; pauseReason?: string }>(`state:${cfg.id}`)?.paused).toBe(true);
    expect(await engine.confirmResume(cfg.id)).toBe(true);
    expect(engine.isPaused(cfg.id)).toBe(false);
    expect(store.getSetting<{ paused?: boolean; pauseReason?: string }>(`state:${cfg.id}`)?.paused).toBe(false);
    engine.shutdown();
  });
});
