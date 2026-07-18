import { describe, expect, it } from "vitest";
import { parseGridParamsV1, worstCaseGridCapitalQuote } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import { drive } from "../src/trading/goldenReplay.js";
import { replayPaperLedger, type PaperLedgerEvent } from "../src/trading/paperLedger.js";
import type { BotConfig } from "../src/trading/types.js";
import type { Candle } from "../src/types.js";

const BOT_ID = "grid-golden-bot";
const T0 = 1_750_000_000_000;
const BAR_MS = 60_000;
const START_BALANCE = 500;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Long buy ladder inside 90..108: levels 92, 94, 96, 98 arm below the anchor. */
const GRID_PARAMS = parseGridParamsV1({
  schemaVersion: "grid-params-v1",
  mode: "long",
  spacing: "arithmetic",
  lowerBound: 90,
  upperBound: 108,
  gridLevels: 8,
  orderQuote: 50,
  outsideRangeAction: "pause",
  cooldownSeconds: 120,
  researchOnly: true,
  executionPermission: false
});

function botConfig(): BotConfig {
  return {
    id: BOT_ID,
    ownerUserId: "golden-owner",
    accountId: `paper:${BOT_ID}`,
    paperPortfolioId: "golden-portfolio",
    paperAllocationMicros: START_BALANCE * 1_000_000,
    paperLedgerEpoch: 1,
    kind: "grid",
    grid: GRID_PARAMS,
    name: "Golden grid",
    strategyName: "Grid BTCUSDT",
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 50,
    leverage: 1,
    bybitCrossCollateral: false,
    notifyMarkers: false,
    status: "running",
    createdAt: T0,
    updatedAt: T0
  };
}

/**
 * 17-bar 1m fixture: anchor at 99 (buys arm at 92/94/96/98), then a ranging
 * 98 -> 100 oscillation that completes exactly THREE 98-buy / 100-sell pairs
 * (cooldown 120s spaces the re-arms), then ONE 4-level gap bar to 91 filling
 * every resting buy of the ladder in a single bar, then a drop below the lower
 * bound that pauses the grid (outsideRangeAction=pause) for the final bars.
 */
function goldenCandles(): Candle[] {
  const closes = [
    99, // anchor
    98, 100, // pair 1: buy level 98, paired sell at 100
    99, 99, // cooldown, re-arm
    98, 100, // pair 2
    99, 99, // cooldown, re-arm
    98, 100, // pair 3
    99, 99, // cooldown, re-arm
    91, // 4-level gap bar: fills the 92, 94, 96 and re-armed 98 buys at once
    89, 89, 89 // outside-range pause tail
  ];
  return closes.map((close, index) => ({
    time: T0 + (index + 1) * BAR_MS,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1
  }));
}

function fills(events: readonly PaperLedgerEvent[]) {
  return events.flatMap((event) => (event.type === "fill" ? [event.data.fill] : []));
}

/** Running balance and committed capital reconstructed from the raw events. */
function capitalPath(events: readonly PaperLedgerEvent[]) {
  let balance = 0;
  let fees = 0;
  let cycleFees = 0;
  let minBalance = Number.POSITIVE_INFINITY;
  let maxCommitted = 0;
  for (const event of events) {
    if (event.type === "account_initialized") balance = event.data.balance;
    else if (event.type === "fee") {
      balance -= event.data.amount;
      fees += event.data.amount;
      cycleFees += event.data.amount;
    } else if (event.type === "cash") balance += event.data.amount;
    else if (event.type === "position") {
      const position = event.data.position;
      if (position) maxCommitted = Math.max(maxCommitted, position.qty * position.entryPrice + cycleFees);
      else cycleFees = 0;
    }
    minBalance = Math.min(minBalance, balance);
  }
  return { balance, fees, minBalance, maxCommitted };
}

/** All order clientIds the drive journaled, i.e. every executed transition key. */
function journalKeys(journal: { orders: Array<{ id: string }> }): string[] {
  return journal.orders.map((order) => order.id).sort();
}

describe("R7 grid golden replay determinism criterion", () => {
  it("drives three pairs, one 4-level gap bar and the outside-range pause byte-identically across runs", async () => {
    const candles = goldenCandles();
    const first = await drive(candles, botConfig());
    const second = await drive(candles, botConfig());

    // Byte-identical event streams: the determinism release gate.
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(JSON.stringify(first.journal)).toBe(JSON.stringify(second.journal));
    expect(JSON.stringify(first.gridSnapshot)).toBe(JSON.stringify(second.gridSnapshot));

    // Exactly three completed pairs before the gap; the gap adds four opens.
    const executed = fills(first.events);
    expect(executed.filter((fill) => fill.kind === "open").length).toBe(7);
    expect(executed.filter((fill) => fill.kind === "close").length).toBe(3);
    expect(executed.every((fill) => fill.reason === "trigger:limit")).toBe(true);

    // Three (100 - 98) * 0.510204 round trips minus the fee model on both legs.
    const perPair = round6((100 - 98) * 0.510204 - (PAPER_FILL_MODEL_V1.feePct / 100) * (100 + 98) * 0.510204);
    const state = first.gridSnapshot?.state;
    expect(state).toMatchObject({ phase: "paused", cyclesCompleted: 3 });
    expect(state?.realizedGridPnl).toBe(round6(round6(perPair + perPair) + perPair));
    expect(state?.inventoryBaseQty).toBe(round6(50 / 92) + round6(50 / 94) + round6(50 / 96) + round6(50 / 98));
    expect(state?.levels.map((level) => level.status))
      .toEqual(["filled", "filled", "filled", "filled", "disabled", "disabled", "disabled", "disabled"]);

    // The pause cancels nothing: all four consolidated pair sells keep resting.
    expect(first.finalState.orders).toHaveLength(4);
    expect(first.finalState.orders.map((order) => order.price)).toEqual([94, 96, 98, 100]);
  });

  it("settles the gap bar in one consolidated placement round: contiguous ordinals, zero duplicates", async () => {
    const result = await drive(goldenCandles(), botConfig());
    const keys = journalKeys(result.journal);
    // 8 anchor placements + 3 pairs of (re-arm, pair) transitions after the
    // first pair + the first pair itself + 4 gap pair placements = 14 keys, in
    // one unbroken ordinal sequence: a cascade or duplicate would break it.
    expect(keys).toHaveLength(new Set(keys).size);
    expect(keys.sort((a, b) => ordinalOf(a) - ordinalOf(b)))
      .toEqual(Array.from({ length: 14 }, (_, at) => `grid:${BOT_ID}:1:${at + 1}`));
  });

  it("replays the recorded ledger to the exact final adapter state", async () => {
    const result = await drive(goldenCandles(), botConfig());
    const replayed = replayPaperLedger(result.events, BOT_ID, 1);
    expect(result.projection).toEqual(replayed);
    expect(replayed.balance).toBe(result.finalState.balance);
    expect(replayed.position).toEqual(result.finalState.position);
    expect(replayed.orders).toEqual(result.finalState.orders);
    expect(replayed.initialized).toBe(true);
  });

  it("resumes mid-cycle from durable artifacts with the identical order clientId set and no duplicates", async () => {
    const candles = goldenCandles();
    const uninterrupted = await drive(candles, botConfig());

    // Restart between the second buy fill and its paired sell, mid-ladder.
    const splitIndex = 6;
    const before = await drive(candles.slice(0, splitIndex), botConfig());
    expect(before.gridSnapshot?.state).toMatchObject({ phase: "active", cyclesCompleted: 1 });
    expect(before.gridSnapshot?.state.levels[3]).toMatchObject({ status: "filled" });
    const resumed = await drive(candles.slice(splitIndex), botConfig(), {
      resume: {
        ledgerEvents: before.events,
        gridSnapshot: before.gridSnapshot,
        journal: before.journal
      }
    });

    expect(JSON.stringify(resumed.events)).toBe(JSON.stringify(uninterrupted.events));
    expect(resumed.finalState).toEqual(uninterrupted.finalState);
    expect(resumed.projection).toEqual(uninterrupted.projection);
    expect(resumed.gridSnapshot?.state).toEqual(uninterrupted.gridSnapshot?.state);

    // RESTART MUST NOT DUPLICATE: the executed transition-key set is identical.
    expect(journalKeys(resumed.journal)).toEqual(journalKeys(uninterrupted.journal));
    expect(journalKeys(resumed.journal)).toHaveLength(new Set(journalKeys(resumed.journal)).size);
  });

  it("never exceeds the reserved worst case and never overdraws the balance", async () => {
    const result = await drive(goldenCandles(), botConfig());
    const worstCase = worstCaseGridCapitalQuote(GRID_PARAMS, PAPER_FILL_MODEL_V1.feePct);
    expect(worstCase).toBe(400.2);
    expect(worstCase).toBeLessThanOrEqual(START_BALANCE);

    const path = capitalPath(result.events);
    expect(path.minBalance).toBeGreaterThanOrEqual(0);
    expect(path.maxCommitted).toBeGreaterThan(0);
    expect(path.maxCommitted).toBeLessThanOrEqual(worstCase);
    expect(path.balance).toBe(result.finalState.balance);
  });

  it("fails closed on malformed candle paths and non-grid configs", async () => {
    const candles = goldenCandles();
    await expect(drive([candles[0]!, candles[0]!], botConfig())).rejects.toThrow(/ascending/);
    await expect(drive([{ ...candles[0]!, low: 200 }], botConfig())).rejects.toThrow(/well-formed/);
    await expect(drive(candles, { ...botConfig(), grid: undefined })).rejects.toThrow(/grid/);
  });
});

function ordinalOf(key: string): number {
  return Number(key.split(":").at(-1));
}
