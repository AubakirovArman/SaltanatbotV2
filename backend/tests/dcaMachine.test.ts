import { describe, expect, it } from "vitest";
import { parseDcaParamsV1, type DcaParamsV1 } from "@saltanatbotv2/contracts";
import { stepDcaMachine } from "../src/trading/dca/machine.js";
import { dcaSnapshotOf } from "../src/trading/dca/runtime.js";
import {
  dcaStateSettingsKey,
  dcaTransitionKey,
  initialDcaState,
  parseDcaStateSnapshotV1,
  parseDcaStateV1,
  type DcaFillObservationV1,
  type DcaStateV1,
  type DcaStepResultV1
} from "../src/trading/dca/types.js";
import type { Candle } from "../src/types.js";

const BOT = "dca-unit";
const CTX = { botId: BOT, feePct: 0.05, slipPct: 0.02 };
const T0 = 1_750_000_000_000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function params(overrides: Partial<DcaParamsV1> = {}): DcaParamsV1 {
  return parseDcaParamsV1({
    schemaVersion: "dca-params-v1",
    direction: "long",
    baseOrderQuote: 100,
    safetyOrderQuote: 50,
    maxSafetyOrders: 2,
    priceDeviationPct: 1,
    stepScale: 2,
    volumeScale: 2,
    takeProfitPct: 1,
    cooldownSeconds: 60,
    researchOnly: true,
    executionPermission: false,
    ...overrides
  });
}

function bar(time: number, close: number, overrides: Partial<Candle> = {}): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1, ...overrides };
}

function step(state: DcaStateV1, candle: Candle, fills: DcaFillObservationV1[], barChecks: boolean, dca = params()): DcaStepResultV1 {
  return stepDcaMachine(state, { bar: candle, fills, barChecks }, dca, CTX);
}

/** Drives one full long cycle: base -> SO1 -> SO2 (cap) -> TP. */
function longCycle(dca = params()) {
  const start = step(initialDcaState(), bar(T0, 100), [], true, dca);
  const base = step(start.state, bar(T0, 100), [{ key: key(1, 1), qty: 1, price: 100.02, kind: "open" }], false, dca);
  const so1Qty = round6(50 / 99.0198);
  const so1 = step(base.state, bar(T0 + 60_000, 99), [{ key: key(1, 3), qty: so1Qty, price: 99.0198, kind: "open" }], false, dca);
  const so2Qty = round6(100 / 97.039404);
  const so2 = step(so1.state, bar(T0 + 120_000, 97), [{ key: key(1, 6), qty: so2Qty, price: 97.039404, kind: "open" }], false, dca);
  return { start, base, so1, so2, so1Qty, so2Qty };
}

function key(cycle: number, ordinal: number): string {
  return `dca:${BOT}:${cycle}:${ordinal}`;
}

describe("dca-state-v1 machine long cycle", () => {
  it("starts a cycle on a closed bar with a deterministic base transition key", () => {
    const { start } = longCycle();
    expect(start.intents).toEqual([{ kind: "placeBase", key: key(1, 1), side: "buy", qty: 1 }]);
    expect(start.state).toMatchObject({ phase: "entering", cycle: 1, ordinal: 2, cycleStartedAt: T0, pendingBase: { key: key(1, 1), qty: 1 } });
    expect(dcaTransitionKey(BOT, 1, 1)).toBe(key(1, 1));
    expect(dcaStateSettingsKey(BOT)).toBe(`dcaState:${BOT}`);
  });

  it("places the take-profit and SO1 from the observed base fill", () => {
    const { base } = longCycle();
    expect(base.state).toMatchObject({ phase: "position", qty: 1, avgEntry: 100.02, soFilled: 0 });
    expect(base.intents).toEqual([
      { kind: "takeProfitLimit", key: key(1, 2), side: "sell", qty: 1, price: 101.0202 },
      { kind: "placeSafetyLimit", key: key(1, 3), side: "buy", index: 1, qty: round6(50 / 99.0198), price: 99.0198 }
    ]);
  });

  it("re-places the take-profit from the exact merged average after each safety fill", () => {
    const { base, so1, so1Qty } = longCycle();
    const mergedQty = 1 + so1Qty;
    const mergedAvg = (base.state.avgEntry * 1 + 99.0198 * so1Qty) / mergedQty;
    expect(so1.state.qty).toBe(mergedQty);
    expect(so1.state.avgEntry).toBe(mergedAvg);
    expect(so1.state.soFilled).toBe(1);
    // SO2 ladders from the SO1 limit price with deviation * stepScale, volume * volumeScale.
    expect(so1.intents).toEqual([
      { kind: "cancelAll", key: key(1, 4) },
      { kind: "takeProfitLimit", key: key(1, 5), side: "sell", qty: mergedQty, price: round6(mergedAvg * 1.01) },
      { kind: "placeSafetyLimit", key: key(1, 6), side: "buy", index: 2, qty: round6(100 / 97.039404), price: round6(99.0198 * 0.98) }
    ]);
  });

  it("stops laddering at maxSafetyOrders and completes the cycle into cooldown on the TP fill", () => {
    const { so1, so2, so1Qty, so2Qty } = longCycle();
    const totalQty = so1.state.qty + so2Qty;
    expect(so2.state.soFilled).toBe(2);
    expect(so2.state.pendingSafety).toBeUndefined();
    expect(so2.intents.map((intent) => intent.kind)).toEqual(["cancelAll", "takeProfitLimit"]);
    const tp = so2.intents[1];
    if (tp?.kind !== "takeProfitLimit") throw new Error("TP intent missing");
    expect(tp.qty).toBe(totalQty);
    expect(so1Qty).toBe(0.50495);

    const tpBar = bar(T0 + 180_000, tp.price);
    const done = step(so2.state, tpBar, [{ key: tp.key, qty: tp.qty, price: tp.price, kind: "close" }], false);
    expect(done.intents).toEqual([{ kind: "cancelAll", key: key(1, 9) }]);
    expect(done.state).toMatchObject({ phase: "cooldown", qty: 0, avgEntry: 0, soFilled: 0, cooldownUntil: tpBar.time + 60_000 });
    expect(done.state.pendingTakeProfit).toBeUndefined();
  });

  it("gates re-entry on cooldown and then opens cycle 2 with a fresh key namespace", () => {
    const { so2 } = longCycle();
    const tp = so2.intents[1];
    if (tp?.kind !== "takeProfitLimit") throw new Error("TP intent missing");
    const done = step(so2.state, bar(T0 + 180_000, tp.price), [{ key: tp.key, qty: tp.qty, price: tp.price, kind: "close" }], false);

    const waiting = step(done.state, bar(T0 + 200_000, 100), [], true);
    expect(waiting.intents).toEqual([]);
    expect(waiting.state.phase).toBe("cooldown");

    const reopened = step(done.state, bar(T0 + 240_000, 100), [], true);
    expect(reopened.intents).toEqual([{ kind: "placeBase", key: `dca:${BOT}:2:1`, side: "buy", qty: 1 }]);
    expect(reopened.state).toMatchObject({ phase: "entering", cycle: 2, ordinal: 2 });
  });

  it("flattens a same-bar safety-then-stale-TP remainder explicitly instead of dropping it", () => {
    const { base, so1Qty } = longCycle();
    const result = step(base.state, bar(T0 + 60_000, 99), [
      { key: key(1, 3), qty: so1Qty, price: 99.0198, kind: "open" },
      { key: key(1, 2), qty: 1, price: 101.0202, kind: "close" }
    ], false);
    expect(result.state.phase).toBe("exiting");
    expect(result.state.pendingClose?.reason).toBe("tp-remainder");
    expect(result.intents.map((intent) => intent.kind)).toEqual(["cancelAll", "closeMarket"]);
    const close = step(result.state, bar(T0 + 60_000, 99), [{ key: result.state.pendingClose!.key, qty: so1Qty, price: 99, kind: "close" }], false);
    expect(close.state.phase).toBe("cooldown");
  });
});

describe("dca-state-v1 machine exits and mirroring", () => {
  it("mirrors a short cycle: sell base, safety above entry, take-profit below the average", () => {
    const dca = params({ direction: "short" });
    const start = step(initialDcaState(), bar(T0, 200), [], true, dca);
    expect(start.intents).toEqual([{ kind: "placeBase", key: key(1, 1), side: "sell", qty: 0.5 }]);
    const base = step(start.state, bar(T0, 200), [{ key: key(1, 1), qty: 0.5, price: 199.96, kind: "open" }], false, dca);
    expect(base.intents).toEqual([
      { kind: "takeProfitLimit", key: key(1, 2), side: "buy", qty: 0.5, price: round6(199.96 * 0.99) },
      { kind: "placeSafetyLimit", key: key(1, 3), side: "sell", index: 1, qty: round6(50 / (199.96 * 1.01)), price: round6(199.96 * 1.01) }
    ]);

    const stopBar = bar(T0 + 60_000, 204, { high: round6(199.96 * 1.02) });
    const stopped = step(base.state, stopBar, [], true, params({ direction: "short", stopLossPct: 2 }));
    expect(stopped.intents.map((intent) => intent.kind)).toEqual(["cancelAll", "closeMarket"]);
    expect(stopped.state.pendingClose?.reason).toBe("sl");
  });

  it("exits on a stop-loss bar cross measured from the average entry", () => {
    const dca = params({ stopLossPct: 2 });
    const { base } = longCycle(dca);
    const holding = step(base.state, bar(T0 + 60_000, 99.5, { low: 99.4 }), [], true, dca);
    expect(holding.intents).toEqual([]);

    const crossed = step(base.state, bar(T0 + 60_000, 98.2, { low: round6(100.02 * 0.98) }), [], true, dca);
    expect(crossed.state.phase).toBe("exiting");
    expect(crossed.state.pendingClose?.reason).toBe("sl");
    expect(crossed.state.pendingSafety).toBeUndefined();
    expect(crossed.state.pendingTakeProfit).toBeUndefined();
    expect(crossed.intents).toEqual([
      { kind: "cancelAll", key: key(1, 4) },
      { kind: "closeMarket", key: key(1, 5), side: "sell", reason: "sl" }
    ]);
  });

  it("manages the trailing take-profit itself: no resting TP, arm at threshold, ratchet, exit", () => {
    const dca = params({ trailingTakeProfitPct: 0.5 });
    const start = step(initialDcaState(), bar(T0, 100), [], true, dca);
    const base = step(start.state, bar(T0, 100), [{ key: key(1, 1), qty: 1, price: 100.02, kind: "open" }], false, dca);
    // Trailing mode never rests a TP limit that would fill at the threshold.
    expect(base.intents.map((intent) => intent.kind)).toEqual(["placeSafetyLimit"]);

    const armed = step(base.state, bar(T0 + 60_000, 101.2, { high: 101.5 }), [], true, dca);
    expect(armed.state.trailArmed).toBe(true);
    expect(armed.state.trailStop).toBe(101.5 * (1 - 0.005));
    expect(armed.intents).toEqual([]); // Arming bar: close 101.2 stays above the trail stop.

    const ratcheted = step(armed.state, bar(T0 + 120_000, 101.8, { high: 102, low: 101.4 }), [], true, dca);
    expect(ratcheted.state.trailStop).toBe(102 * (1 - 0.005));
    expect(ratcheted.state.phase).toBe("exiting");
    expect(ratcheted.state.pendingClose?.reason).toBe("trail");

    // On the arming bar itself only a close beyond the trail stop exits.
    const armingExit = step(base.state, bar(T0 + 60_000, 100.9, { high: 101.5 }), [], true, dca);
    expect(armingExit.state.phase).toBe("exiting");
    expect(armingExit.state.pendingClose?.reason).toBe("trail");
  });

  it("closes at market and stops terminally when the cycle outlives maxCycleDurationHours", () => {
    const dca = params({ maxCycleDurationHours: 1 });
    const { base } = longCycle(dca);
    const expired = step(base.state, bar(T0 + 3_600_000, 100), [], true, dca);
    expect(expired.state.pendingClose?.reason).toBe("duration");

    const closed = step(expired.state, bar(T0 + 3_600_000, 100), [{ key: expired.state.pendingClose!.key, qty: 1, price: 100, kind: "close" }], false, dca);
    expect(closed.state.phase).toBe("stopped");
    expect(closed.state.stopReason).toContain("maxCycleDurationHours=1");
    expect(closed.state.cooldownUntil).toBeUndefined();

    const afterStop = step(closed.state, bar(T0 + 3_660_000, 100), [], true, dca);
    expect(afterStop.intents).toEqual([]);
    expect(afterStop.state.phase).toBe("stopped");
  });
});

describe("dca-state-v1 machine determinism and snapshots", () => {
  it("emits byte-identical states, intents and idempotency keys for identical inputs", () => {
    const first = longCycle();
    const second = longCycle();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const keys = [...first.start.intents, ...first.base.intents, ...first.so1.intents, ...first.so2.intents].map((intent) => intent.key);
    expect(keys).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((ordinal) => key(1, ordinal)));
  });

  it("never mutates the input state", () => {
    const { base } = longCycle();
    const before = JSON.stringify(base.state);
    step(base.state, bar(T0 + 60_000, 99), [{ key: key(1, 3), qty: round6(50 / 99.0198), price: 99.0198, kind: "open" }], false);
    expect(JSON.stringify(base.state)).toBe(before);
  });

  it("round-trips a mid-cycle snapshot through JSON exactly and fails closed on tampering", () => {
    const { so1 } = longCycle();
    const snapshot = dcaSnapshotOf({ botId: BOT, ledgerEpoch: 3 }, so1.state, T0 + 90_000, key(1, 6));
    const parsed = parseDcaStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual(snapshot);
    expect(parsed.state).toEqual(so1.state);

    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.state.phase = "warp";
    expect(() => parseDcaStateSnapshotV1(tampered)).toThrow(/unsupported/);
    const stoppedMismatch = JSON.parse(JSON.stringify(snapshot));
    stoppedMismatch.state.phase = "stopped";
    expect(() => parseDcaStateSnapshotV1(stoppedMismatch)).toThrow(/stop reason/);
    const wrongVersion = JSON.parse(JSON.stringify(snapshot));
    wrongVersion.schemaVersion = "dca-state-v2";
    expect(() => parseDcaStateSnapshotV1(wrongVersion)).toThrow(/schema version/);
    expect(() => parseDcaStateV1({ ...so1.state, pendingSafety: { key: "k", qty: 1, price: 1 } })).toThrow(/pendingSafety.index/);
  });

  it("fails closed on unknown fills, invalid fills and out-of-envelope context", () => {
    const { base } = longCycle();
    expect(() => step(base.state, bar(T0 + 60_000, 99), [{ key: "dca:other:1:1", qty: 1, price: 99, kind: "open" }], false))
      .toThrow(/unknown transition/);
    expect(() => step(base.state, bar(T0 + 60_000, 99), [{ key: key(1, 3), qty: 0, price: 99, kind: "open" }], false))
      .toThrow(/invalid fill/);
    expect(() => stepDcaMachine(base.state, { bar: bar(T0, 100), fills: [], barChecks: true }, params(), { botId: BOT, feePct: -1, slipPct: 0 }))
      .toThrow(/fill-model envelope/);
    expect(() => stepDcaMachine({ ...base.state, schemaVersion: "dca-state-v2" as never }, { bar: bar(T0, 100), fills: [], barChecks: true }, params(), CTX))
      .toThrow(/unsupported state version/);
  });
});
