import { describe, expect, it, vi } from "vitest";
import { EmergencyStopConflictError, EmergencyStopCoordinator, type EmergencyStopResult } from "../src/trading/emergencyStop.js";
import type { ExchangeAdapter, ExecOrder, PendingOrder, PositionState } from "../src/trading/types.js";

interface FakeOptions {
  orders?: PendingOrder[];
  positions?: PositionState[];
  retainOrders?: boolean;
  retainPositions?: boolean;
  throwOrderReads?: boolean;
  delayMs?: number;
  quiesceAttempts?: number;
}

function harness(options: FakeOptions = {}) {
  let openOrders = [...(options.orders ?? [])];
  let openPositions = [...(options.positions ?? [])];
  let stored: EmergencyStopResult | undefined;
  const executions: ExecOrder[] = [];
  const adapter: ExchangeAdapter = {
    id: "binance",
    market: "futures",
    price: async () => 100,
    account: async () => ({ balance: 1_000, equity: 1_000, currency: "USDT" }),
    position: async (symbol) => openPositions.find((position) => position.symbol === symbol) ?? null,
    positions: async () => openPositions,
    orders: async () => {
      if (options.throwOrderReads) throw new Error("orders unavailable");
      return openOrders;
    },
    execute: async (order) => {
      executions.push(order);
      if (order.action === "cancelall") {
        if (!options.retainOrders) openOrders = openOrders.filter((candidate) => candidate.symbol !== order.symbol);
        return { ok: !options.retainOrders, message: options.retainOrders ? "cancel rejected" : "cancelled", fills: [] };
      }
      if (order.action === "flatten") {
        if (!options.retainPositions) openPositions = openPositions.filter((candidate) => candidate.symbol !== order.symbol);
        return { ok: !options.retainPositions, message: options.retainPositions ? "flatten rejected" : "flattened", fills: [] };
      }
      return { ok: false, message: "unexpected", fills: [] };
    }
  };
  const stop = vi.fn();
  const coordinator = new EmergencyStopCoordinator({
    running: () => [{ config: { id: "bot-1", exchange: "binance" as const, market: "futures" as const, symbol: "BTCUSDT" }, adapter }],
    stop,
    load: () => stored,
    save: (value) => { stored = structuredClone(value); },
    clear: () => { stored = undefined; },
    reconcileAttempts: 2,
    reconcileDelayMs: options.delayMs ?? 0,
    quiesceAttempts: options.quiesceAttempts
  });
  return { coordinator, adapter, stop, executions, stored: () => stored, positions: () => openPositions };
}

const pending = (id: string, symbol = "BTCUSDT"): PendingOrder => ({
  id,
  symbol,
  side: "buy",
  type: "limit",
  qty: 1,
  price: 90,
  reduceOnly: false,
  tif: "GTC",
  createdAt: 1
});

const position = (symbol = "BTCUSDT"): PositionState => ({
  symbol,
  side: "long",
  qty: 2,
  entryPrice: 100,
  leverage: 2,
  openedAt: 1
});

describe("account-level emergency stop", () => {
  it("atomically blocks live orders, stops bots, cancels orders and reconciles terminal state", async () => {
    const test = harness({ orders: [pending("one"), pending("two", "ETHUSDT")] });
    const running = test.coordinator.run({ operationId: "cancel-only" });
    expect(() => test.coordinator.assertLiveOrderAllowed()).toThrow(EmergencyStopConflictError);
    expect(test.coordinator.status()).toMatchObject({ phase: "stopping", ok: false });

    const result = await running;
    expect(result).toMatchObject({ operationId: "cancel-only", phase: "terminal", ok: true, botsStopped: 1 });
    expect(result.accounts[0]).toMatchObject({
      account: "binance:futures",
      ok: true,
      cancelOrders: { state: "confirmed", remaining: [] },
      flattenPositions: { state: "not_requested" }
    });
    expect(test.stop).toHaveBeenCalledWith("bot-1");
    expect(test.executions.filter((order) => order.action === "cancelall").map((order) => order.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(test.stored()).toEqual(result);
  });

  it("never flattens without the explicit option", async () => {
    const test = harness({ positions: [position()] });
    const result = await test.coordinator.run({ operationId: "leave-positions" });
    expect(result.ok).toBe(true);
    expect(test.positions()).toHaveLength(1);
    expect(test.executions.some((order) => order.action === "flatten")).toBe(false);
  });

  it("uses reduce-only market flattening only when requested and verifies flat state", async () => {
    const test = harness({ positions: [{ ...position(), hedged: true }, { ...position("ETHUSDT"), side: "short", hedged: true, positionIndex: 2 }] });
    const result = await test.coordinator.run({ operationId: "flatten", flatten: true });
    expect(result).toMatchObject({ phase: "terminal", ok: true, flattenRequested: true });
    expect(result.accounts[0].flattenPositions).toMatchObject({ state: "confirmed", attempted: true, remaining: [] });
    const flattenOrders = test.executions.filter((order) => order.action === "flatten");
    expect(flattenOrders).toHaveLength(2);
    expect(flattenOrders.every((order) => order.reduceOnly && order.type === "market" && order.closePct === 100)).toBe(true);
    expect(flattenOrders[0]).toMatchObject({ positionSide: "long" });
    expect(flattenOrders[1]).toMatchObject({ positionSide: "short", positionIndex: 2 });
  });

  it("reports partial failure when exchange orders remain", async () => {
    const test = harness({ orders: [pending("one")], retainOrders: true });
    const result = await test.coordinator.run({ operationId: "cancel-fails" });
    expect(result).toMatchObject({ phase: "partial_failure", ok: false });
    expect(result.accounts[0]).toMatchObject({ ok: false, cancelOrders: { state: "failed", remaining: [{ id: "one", symbol: "BTCUSDT" }] } });
    expect(result.errors.join(" ")).toContain("did not reach");
    expect(() => test.coordinator.resetAfterTerminal()).toThrow(/unresolved failures/i);
  });

  it("reports partial failure when a requested position remains open", async () => {
    const test = harness({ positions: [position()], retainPositions: true });
    const result = await test.coordinator.run({ operationId: "flatten-fails", flatten: true });
    expect(result).toMatchObject({ phase: "partial_failure", ok: false });
    expect(result.accounts[0].flattenPositions).toMatchObject({ state: "failed", remaining: [{ symbol: "BTCUSDT", side: "long", qty: 2 }] });
  });

  it("returns the same persisted result for an idempotent operation id", async () => {
    const test = harness({ orders: [pending("one")] });
    const first = await test.coordinator.run({ operationId: "same" });
    const executionCount = test.executions.length;
    const second = await test.coordinator.run({ operationId: "same" });
    expect(second).toEqual(first);
    expect(test.executions).toHaveLength(executionCount);
  });

  it("waits for an already in-flight live request before account cancellation", async () => {
    const test = harness({ orders: [pending("one")], delayMs: 1 });
    const release = test.coordinator.beginLiveOrder();
    const running = test.coordinator.run({ operationId: "quiesce" });
    expect(test.coordinator.run({ operationId: "quiesce" })).toBe(running);
    expect(() => test.coordinator.run({ operationId: "different" })).toThrow(/already running/i);
    expect(test.executions).toHaveLength(0);
    release();
    const result = await running;
    expect(result).toMatchObject({ phase: "terminal", ok: true });
    expect(test.executions.some((order) => order.action === "cancelall")).toBe(true);
  });

  it("cannot report success if an in-flight live request misses the quiescence deadline", async () => {
    const test = harness({ quiesceAttempts: 1 });
    const release = test.coordinator.beginLiveOrder();
    const result = await test.coordinator.run({ operationId: "in-flight-timeout" });
    release();
    expect(result).toMatchObject({ phase: "partial_failure", ok: false });
    expect(result.errors.join(" ")).toContain("did not finish");
  });

  it("cancels configured accounts even when no bot is currently running", async () => {
    const test = harness({ orders: [pending("detached")] });
    let stored: EmergencyStopResult | undefined;
    const coordinator = new EmergencyStopCoordinator({
      running: () => [],
      stop: () => undefined,
      additionalAdapters: () => [test.adapter],
      load: () => stored,
      save: (value) => { stored = structuredClone(value); },
      clear: () => { stored = undefined; },
      reconcileAttempts: 1,
      reconcileDelayMs: 0
    });
    const result = await coordinator.run({ operationId: "configured-account" });
    expect(result).toMatchObject({ phase: "terminal", ok: true, botsStopped: 0 });
    expect(result.accounts[0]).toMatchObject({ account: "binance:futures", cancelOrders: { state: "confirmed" } });
  });

  it("fails closed after a process interruption and requires a new retry operation", async () => {
    let stored: EmergencyStopResult | undefined = {
      operationId: "interrupted",
      phase: "stopping",
      ok: false,
      flattenRequested: false,
      startedAt: 1,
      botsStopped: 1,
      accounts: [],
      errors: []
    };
    const coordinator = new EmergencyStopCoordinator({
      running: () => [],
      stop: () => undefined,
      load: () => stored,
      save: (value) => { stored = structuredClone(value); },
      clear: () => { stored = undefined; },
      reconcileAttempts: 1,
      reconcileDelayMs: 0
    });
    expect(coordinator.status()).toMatchObject({ phase: "partial_failure", ok: false });
    expect(() => coordinator.assertLiveStartAllowed()).toThrow(/blocked/i);
    expect((await coordinator.run({ operationId: "retry" })).phase).toBe("terminal");
    coordinator.resetAfterTerminal();
    expect(coordinator.status()).toMatchObject({ phase: "idle", ok: true });
  });

  it("fails closed when durable emergency state is malformed", () => {
    const coordinator = new EmergencyStopCoordinator({
      running: () => [],
      stop: () => undefined,
      load: () => ({ phase: "unknown" } as unknown as EmergencyStopResult),
      save: () => undefined,
      clear: () => undefined
    });
    expect(coordinator.status()).toMatchObject({ phase: "partial_failure", ok: false });
    expect(() => coordinator.assertLiveStartAllowed()).toThrow(/blocked/i);
  });

  it("does not claim confirmation when account reads cannot be reconciled", async () => {
    const test = harness({ throwOrderReads: true });
    const result = await test.coordinator.run({ operationId: "read-fails" });
    expect(result).toMatchObject({ phase: "partial_failure", ok: false });
    expect(result.accounts[0].cancelOrders.errors.join(" ")).toContain("reconciliation failed");
  });

  it("stays fail-closed when a reconciled terminal result cannot be persisted", async () => {
    let saves = 0;
    const coordinator = new EmergencyStopCoordinator({
      running: () => [],
      stop: () => undefined,
      load: () => undefined,
      save: () => {
        saves += 1;
        if (saves >= 3) throw new Error("disk unavailable");
      },
      clear: () => undefined,
      reconcileAttempts: 1,
      reconcileDelayMs: 0
    });
    const result = await coordinator.run({ operationId: "persistence-fails" });
    expect(result).toMatchObject({ phase: "partial_failure", ok: false });
    expect(result.errors.join(" ")).toContain("persist the reconciled terminal state");
    expect(() => coordinator.assertLiveStartAllowed()).toThrow(/blocked/i);
  });
});
