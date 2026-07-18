import { describe, expect, it } from "vitest";
import { parseGridParamsV1, type GridParamsV1 } from "@saltanatbotv2/contracts";
import { stepGridMachine } from "../src/trading/grid/machine.js";
import { gridSnapshotOf } from "../src/trading/grid/runtime.js";
import {
  gridStateSettingsKey,
  gridTransitionKey,
  initialGridState,
  parseGridStateSnapshotV1,
  parseGridStateV1,
  type GridFillObservationV1,
  type GridStateV1,
  type GridStepResultV1
} from "../src/trading/grid/types.js";
import type { Candle } from "../src/types.js";

const BOT = "grid-unit";
const CTX = { botId: BOT, feePct: 0.05, slipPct: 0.02 };
const T0 = 1_750_000_000_000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Ladder quantities for the default 90..110 x 4 grid at orderQuote 49. */
const q94 = round6(49 / 94);
const q98 = 0.5;
const q102 = round6(49 / 102);
const q106 = round6(49 / 106);

function params(overrides: Partial<GridParamsV1> = {}): GridParamsV1 {
  return parseGridParamsV1({
    schemaVersion: "grid-params-v1",
    mode: "neutral",
    spacing: "arithmetic",
    lowerBound: 90,
    upperBound: 110,
    gridLevels: 4,
    orderQuote: 49,
    outsideRangeAction: "pause",
    cooldownSeconds: 60,
    researchOnly: true,
    executionPermission: false,
    ...overrides
  });
}

function bar(time: number, close: number, overrides: Partial<Candle> = {}): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1, ...overrides };
}

function step(state: GridStateV1, candle: Candle, fills: GridFillObservationV1[], barChecks: boolean, grid = params()): GridStepResultV1 {
  return stepGridMachine(state, { bar: candle, fills, barChecks }, grid, CTX);
}

function key(ordinal: number): string {
  return `grid:${BOT}:1:${ordinal}`;
}

/** Anchors the default neutral ladder: buys at 94/98, sells at 102/106. */
function anchored(grid = params(), close = 100): GridStepResultV1 {
  return step(initialGridState(), bar(T0, close), [], true, grid);
}

/** Anchor -> buy level 2 fill -> paired sell resting at 102 (key 1:5). */
function basePosition(grid = params()) {
  const anchor = anchored(grid);
  const base = step(anchor.state, bar(T0 + 60_000, 98), [{ key: key(2), qty: q98, price: 98, kind: "open" }], false, grid);
  return { anchor, base };
}

describe("grid-state-v1 machine anchoring", () => {
  it("anchors on the first in-range close: buys strictly below, sells strictly above, deterministic keys", () => {
    const anchor = anchored();
    expect(anchor.intents).toEqual([
      { kind: "placeLevelLimit", key: key(1), side: "buy", index: 1, qty: q94, price: 94 },
      { kind: "placeLevelLimit", key: key(2), side: "buy", index: 2, qty: q98, price: 98 },
      { kind: "placeLevelLimit", key: key(3), side: "sell", index: 3, qty: q102, price: 102 },
      { kind: "placeLevelLimit", key: key(4), side: "sell", index: 4, qty: q106, price: 106 }
    ]);
    expect(anchor.state).toMatchObject({ phase: "active", epochCycle: 1, cursorOrdinal: 5 });
    expect(anchor.state.levels.map((level) => level.status)).toEqual(["resting", "resting", "resting", "resting"]);
    expect(gridTransitionKey(BOT, 1, 1)).toBe(key(1));
    expect(gridStateSettingsKey(BOT)).toBe(`gridState:${BOT}`);
  });

  it("keeps waiting while the close sits outside the range and never arms a level at the exact anchor price", () => {
    const waiting = anchored(params(), 89);
    expect(waiting.intents).toEqual([]);
    expect(waiting.state).toMatchObject({ phase: "idle", epochCycle: 0, levels: [] });

    // Close exactly on the 102 level: that level never arms (documented rule).
    const exact = anchored(params(), 102);
    expect(exact.intents.map((intent) => `${intent.kind === "placeLevelLimit" ? intent.side : "?"}@${intent.kind === "placeLevelLimit" ? intent.price : 0}`))
      .toEqual(["buy@94", "buy@98", "sell@106"]);
    expect(exact.state.levels[2]).toMatchObject({ price: 102, side: "sell", status: "disabled" });
  });

  it("arms only the buy ladder in long mode and only the sell ladder in short mode", () => {
    const long = anchored(params({ mode: "long" }));
    expect(long.intents).toEqual([
      { kind: "placeLevelLimit", key: key(1), side: "buy", index: 1, qty: q94, price: 94 },
      { kind: "placeLevelLimit", key: key(2), side: "buy", index: 2, qty: q98, price: 98 }
    ]);
    expect(long.state.levels.map((level) => level.status)).toEqual(["resting", "resting", "disabled", "disabled"]);

    const short = anchored(params({ mode: "short" }));
    expect(short.intents).toEqual([
      { kind: "placeLevelLimit", key: key(1), side: "sell", index: 3, qty: q102, price: 102 },
      { kind: "placeLevelLimit", key: key(2), side: "sell", index: 4, qty: q106, price: 106 }
    ]);
    expect(short.state.levels.map((level) => level.status)).toEqual(["disabled", "disabled", "resting", "resting"]);
  });
});

describe("grid-state-v1 machine pairs and cooldown", () => {
  it("pairs a buy fill with a sell at the adjacent upper level and realizes the exact fee-adjusted spread", () => {
    const { base } = basePosition();
    expect(base.intents).toEqual([{ kind: "placePairLimit", key: key(5), side: "sell", index: 2, qty: q98, price: 102 }]);
    expect(base.state.levels[1]).toMatchObject({ status: "filled", openQty: q98, openPrice: 98, pair: { key: key(5), qty: q98, price: 102 } });
    expect(base.state).toMatchObject({ inventoryBaseQty: q98, inventoryAvgCost: 98 });

    const done = step(base.state, bar(T0 + 120_000, 102), [{ key: key(5), qty: q98, price: 102, kind: "close" }], false);
    // (102 - 98) * 0.5 minus the 0.05% fee model on both legs: 2 - 0.05.
    expect(done.intents).toEqual([]);
    expect(done.state).toMatchObject({ realizedGridPnl: 1.95, cyclesCompleted: 1, inventoryBaseQty: 0, inventoryAvgCost: 0 });
    expect(done.state.levels[1]).toMatchObject({ status: "cooldown", cooldownUntil: T0 + 180_000 });
  });

  it("re-arms the original ladder order only after cooldownSeconds elapse", () => {
    const { base } = basePosition();
    const done = step(base.state, bar(T0 + 120_000, 102), [{ key: key(5), qty: q98, price: 102, kind: "close" }], false);

    const early = step(done.state, bar(T0 + 150_000, 100), [], true);
    expect(early.intents).toEqual([]);
    expect(early.state.levels[1]!.status).toBe("cooldown");

    const rearmed = step(done.state, bar(T0 + 180_000, 100), [], true);
    expect(rearmed.intents).toEqual([{ kind: "placeLevelLimit", key: key(6), side: "buy", index: 2, qty: q98, price: 98 }]);
    expect(rearmed.state.levels[1]).toMatchObject({ status: "resting", cooldownUntil: undefined });
  });

  it("mirrors the sell ladder: pair buy at the adjacent lower level with exact realized accounting", () => {
    const anchor = anchored();
    const short = step(anchor.state, bar(T0 + 60_000, 102), [{ key: key(3), qty: q102, price: 102, kind: "open" }], false);
    expect(short.intents).toEqual([{ kind: "placePairLimit", key: key(5), side: "buy", index: 3, qty: q102, price: 98 }]);
    expect(short.state).toMatchObject({ inventoryBaseQty: -q102, inventoryAvgCost: 102 });

    const done = step(short.state, bar(T0 + 120_000, 98), [{ key: key(5), qty: q102, price: 98, kind: "close" }], false);
    expect(done.state.realizedGridPnl).toBe(round6((102 - 98) * q102 - (0.05 / 100) * (98 + 102) * q102));
    expect(done.state).toMatchObject({ cyclesCompleted: 1, inventoryBaseQty: 0 });
  });

  it("pairs the outermost levels against the range bounds themselves", () => {
    const top = anchored(params({ mode: "long" }), 107);
    // All four levels sit strictly below 107, so the whole buy ladder arms.
    expect(top.intents).toHaveLength(4);
    const topFill = step(top.state, bar(T0 + 60_000, 106), [{ key: key(4), qty: q106, price: 106, kind: "open" }], false, params({ mode: "long" }));
    expect(topFill.intents).toEqual([{ kind: "placePairLimit", key: key(5), side: "sell", index: 4, qty: q106, price: 110 }]);

    const bottom = anchored(params({ mode: "short" }), 92);
    expect(bottom.intents).toHaveLength(4);
    const bottomFill = step(bottom.state, bar(T0 + 60_000, 94), [{ key: key(1), qty: q94, price: 94, kind: "open" }], false, params({ mode: "short" }));
    expect(bottomFill.intents).toEqual([{ kind: "placePairLimit", key: key(5), side: "buy", index: 1, qty: q94, price: 90 }]);
  });
});

describe("grid-state-v1 machine gap batches", () => {
  it("settles a multi-level gap in one step with one consolidated placement round and zero duplicates", () => {
    const anchor = anchored();
    // The adapter reports the batch unordered; the machine sorts by (price, side, key).
    const gap = step(anchor.state, bar(T0 + 60_000, 93), [
      { key: key(2), qty: q98, price: 98, kind: "open" },
      { key: key(1), qty: q94, price: 94, kind: "open" }
    ], true);

    expect(gap.intents).toEqual([
      { kind: "placePairLimit", key: key(5), side: "sell", index: 1, qty: q94, price: 98 },
      { kind: "placePairLimit", key: key(6), side: "sell", index: 2, qty: q98, price: 102 }
    ]);
    expect(new Set(gap.intents.map((intent) => intent.key)).size).toBe(gap.intents.length);
    expect(gap.state.cursorOrdinal).toBe(7);
    expect(gap.state.levels.map((level) => level.status)).toEqual(["filled", "filled", "resting", "resting"]);
    // Deterministic batch order: the 94 buy merges first, then the 98 buy.
    const first = (94 * q94) / q94;
    expect(gap.state.inventoryBaseQty).toBe(q94 + q98);
    expect(gap.state.inventoryAvgCost).toBe((first * q94 + 98 * q98) / (q94 + q98));

    const again = step(anchor.state, bar(T0 + 60_000, 93), [
      { key: key(2), qty: q98, price: 98, kind: "open" },
      { key: key(1), qty: q94, price: 94, kind: "open" }
    ], true);
    expect(JSON.stringify(again)).toBe(JSON.stringify(gap));
  });
});

describe("grid-state-v1 machine outside-range and stops", () => {
  it("pauses outside the range without cancelling, defers pairs, and resumes on re-entry", () => {
    const anchor = anchored();
    const paused = step(anchor.state, bar(T0 + 60_000, 89), [], true);
    expect(paused.intents).toEqual([]);
    expect(paused.state.phase).toBe("paused");
    expect(paused.state.levels.every((level) => level.status === "resting" && level.order !== undefined)).toBe(true);

    // A resting order can still fill while paused; its pair placement waits.
    const filled = step(paused.state, bar(T0 + 120_000, 89), [{ key: key(1), qty: q94, price: 94, kind: "open" }], true);
    expect(filled.intents).toEqual([]);
    expect(filled.state.phase).toBe("paused");
    expect(filled.state.levels[0]!.status).toBe("filled");

    const resumed = step(filled.state, bar(T0 + 180_000, 100), [], true);
    expect(resumed.state.phase).toBe("active");
    expect(resumed.intents).toEqual([{ kind: "placePairLimit", key: key(5), side: "sell", index: 1, qty: q94, price: 98 }]);
  });

  it("stops terminally outside the range with one cancel-all and the inventory kept", () => {
    const grid = params({ outsideRangeAction: "stop" });
    const { base } = basePosition(grid);
    const stopped = step(base.state, bar(T0 + 120_000, 89), [], true, grid);
    expect(stopped.intents).toEqual([{ kind: "cancelAll", key: key(6) }]);
    expect(stopped.state.phase).toBe("stopped");
    expect(stopped.state.stopReason).toContain("outsideRangeAction=stop");
    expect(stopped.state).toMatchObject({ inventoryBaseQty: q98, inventoryAvgCost: 98 });
    expect(stopped.state.levels.map((level) => level.status)).toEqual(["disabled", "filled", "disabled", "disabled"]);
    expect(stopped.state.levels[1]!.pair).toBeUndefined();

    const after = step(stopped.state, bar(T0 + 180_000, 100), [], true, grid);
    expect(after.intents).toEqual([]);
    expect(after.state.phase).toBe("stopped");
  });

  it("flattens at market and stops terminally when the stop-loss is crossed", () => {
    const grid = params({ stopLossPrice: 85 });
    const { base } = basePosition(grid);
    const crossed = step(base.state, bar(T0 + 120_000, 91, { low: 85 }), [], true, grid);
    expect(crossed.intents).toEqual([
      { kind: "cancelAll", key: key(6) },
      { kind: "closeMarket", key: key(7), side: "sell", reason: "stop-loss" }
    ]);
    expect(crossed.state.pendingStop).toEqual({ key: key(7), reason: "stop-loss" });

    const flattened = step(crossed.state, bar(T0 + 120_000, 91, { low: 85 }), [{ key: key(7), qty: q98, price: 90.98, kind: "close" }], false, grid);
    expect(flattened.state.phase).toBe("stopped");
    expect(flattened.state.stopReason).toContain("stop-loss 85");
    expect(flattened.state).toMatchObject({ inventoryBaseQty: 0, inventoryAvgCost: 0 });

    // A flat grid needs no market flatten: the stop is immediate.
    const flat = step(anchored(grid).state, bar(T0 + 60_000, 91, { low: 85 }), [], true, grid);
    expect(flat.intents).toEqual([{ kind: "cancelAll", key: key(5) }]);
    expect(flat.state.phase).toBe("stopped");
  });

  it("mirrors the short stop-loss: crossed by the bar high and flattened with a market buy", () => {
    const grid = params({ mode: "short", stopLossPrice: 115 });
    const anchor = anchored(grid, 92);
    const short = step(anchor.state, bar(T0 + 60_000, 94), [{ key: key(1), qty: q94, price: 94, kind: "open" }], false, grid);
    expect(short.state.inventoryBaseQty).toBe(-q94);
    const crossed = step(short.state, bar(T0 + 120_000, 108, { high: 115 }), [], true, grid);
    expect(crossed.intents.map((intent) => intent.kind)).toEqual(["cancelAll", "closeMarket"]);
    expect(crossed.intents[1]).toMatchObject({ side: "buy", reason: "stop-loss" });
  });

  it("cancels and stops terminally once maxCycles round trips complete", () => {
    const grid = params({ maxCycles: 1 });
    const { base } = basePosition(grid);
    const done = step(base.state, bar(T0 + 120_000, 102), [{ key: key(5), qty: q98, price: 102, kind: "close" }], false, grid);
    expect(done.intents).toEqual([{ kind: "cancelAll", key: key(6) }]);
    expect(done.state.phase).toBe("stopped");
    expect(done.state.stopReason).toContain("maxCycles=1");
    expect(done.state.cyclesCompleted).toBe(1);
    expect(done.state.levels.map((level) => level.status)).toEqual(["disabled", "disabled", "disabled", "disabled"]);
  });
});

describe("grid-state-v1 machine determinism and snapshots", () => {
  it("emits byte-identical states, intents and sequential idempotency keys for identical inputs", () => {
    const first = basePosition();
    const second = basePosition();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const keys = [...first.anchor.intents, ...first.base.intents].map((intent) => intent.key);
    expect(keys).toEqual([1, 2, 3, 4, 5].map((ordinal) => key(ordinal)));
  });

  it("never mutates the input state", () => {
    const { base } = basePosition();
    const before = JSON.stringify(base.state);
    step(base.state, bar(T0 + 120_000, 102), [{ key: key(5), qty: q98, price: 102, kind: "close" }], false);
    expect(JSON.stringify(base.state)).toBe(before);
  });

  it("round-trips a mid-ladder snapshot through JSON byte-identically and fails closed on tampering", () => {
    const anchor = anchored();
    const gap = step(anchor.state, bar(T0 + 60_000, 93), [
      { key: key(1), qty: q94, price: 94, kind: "open" },
      { key: key(2), qty: q98, price: 98, kind: "open" }
    ], true);
    const done = step(gap.state, bar(T0 + 120_000, 102), [{ key: key(6), qty: q98, price: 102, kind: "close" }], false);
    const snapshot = gridSnapshotOf({ botId: BOT, ledgerEpoch: 3 }, done.state, T0 + 120_000, key(6));
    const parsed = parseGridStateSnapshotV1(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual(snapshot);
    expect(parsed.state).toEqual(done.state);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(snapshot));

    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.state.phase = "warp";
    expect(() => parseGridStateSnapshotV1(tampered)).toThrow(/unsupported/);
    const stoppedMismatch = JSON.parse(JSON.stringify(snapshot));
    stoppedMismatch.state.phase = "stopped";
    expect(() => parseGridStateSnapshotV1(stoppedMismatch)).toThrow(/stop reason/);
    const wrongVersion = JSON.parse(JSON.stringify(snapshot));
    wrongVersion.schemaVersion = "grid-state-v2";
    expect(() => parseGridStateSnapshotV1(wrongVersion)).toThrow(/schema version/);
    const outOfOrder = JSON.parse(JSON.stringify(done.state));
    [outOfOrder.levels[0], outOfOrder.levels[1]] = [outOfOrder.levels[1], outOfOrder.levels[0]];
    expect(() => parseGridStateV1(outOfOrder)).toThrow(/ladder order/);
    const restingMismatch = JSON.parse(JSON.stringify(done.state));
    restingMismatch.levels[2].order = undefined;
    expect(() => parseGridStateV1(restingMismatch)).toThrow(/resting order/);
    const cooldownMismatch = JSON.parse(JSON.stringify(done.state));
    cooldownMismatch.levels[2].cooldownUntil = T0;
    expect(() => parseGridStateV1(cooldownMismatch)).toThrow(/cooldown time/);
  });

  it("fails closed on unknown fills, invalid fills and out-of-envelope context", () => {
    const { base } = basePosition();
    expect(() => step(base.state, bar(T0 + 120_000, 102), [{ key: "grid:other:1:1", qty: 1, price: 102, kind: "close" }], false))
      .toThrow(/unknown transition/);
    expect(() => step(base.state, bar(T0 + 120_000, 102), [{ key: key(5), qty: 0, price: 102, kind: "close" }], false))
      .toThrow(/invalid fill/);
    expect(() => stepGridMachine(base.state, { bar: bar(T0, 100), fills: [], barChecks: true }, params(), { botId: BOT, feePct: -1, slipPct: 0 }))
      .toThrow(/fill-model envelope/);
    expect(() => stepGridMachine({ ...base.state, schemaVersion: "grid-state-v2" as never }, { bar: bar(T0, 100), fills: [], barChecks: true }, params(), CTX))
      .toThrow(/unsupported state version/);
  });
});
