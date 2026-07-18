import { describe, expect, it } from "vitest";
import { parseDcaParamsV1, worstCaseDcaCapitalQuote } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import { drive } from "../src/trading/goldenReplay.js";
import { replayPaperLedger, type PaperLedgerEvent } from "../src/trading/paperLedger.js";
import type { BotConfig } from "../src/trading/types.js";
import type { Candle } from "../src/types.js";

const BOT_ID = "dca-golden-bot";
const T0 = 1_750_000_000_000;
const BAR_MS = 60_000;
const START_BALANCE = 500;

const DCA_PARAMS = parseDcaParamsV1({
  schemaVersion: "dca-params-v1",
  direction: "long",
  baseOrderQuote: 100,
  safetyOrderQuote: 100,
  maxSafetyOrders: 3,
  priceDeviationPct: 2,
  stepScale: 1,
  volumeScale: 1,
  takeProfitPct: 2,
  cooldownSeconds: 86_400,
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
    kind: "dca",
    dca: DCA_PARAMS,
    name: "Golden DCA",
    strategyName: "DCA BTCUSDT",
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    bybitCrossCollateral: false,
    notifyMarkers: false,
    status: "running",
    createdAt: T0,
    updatedAt: T0
  };
}

/**
 * ~120-bar 1m fixture: flat open, a dip deep enough to trigger exactly two
 * safety orders (98.0196 and 96.059208 for a 100.02 base entry), then a rally
 * through the merged-average take-profit, then a flat tail inside cooldown.
 */
function goldenCandles(): Candle[] {
  const closes: number[] = [];
  for (let index = 0; index < 10; index += 1) closes.push(100);
  for (let index = 1; index <= 10; index += 1) closes.push(100 - 0.2 * index); // 99.8 .. 98.0 (SO1)
  for (let index = 1; index <= 10; index += 1) closes.push(98 - 0.2 * index); // 97.8 .. 96.0 (SO2)
  for (let index = 1; index <= 30; index += 1) closes.push(96 + 0.25 * index); // recovery through the TP
  while (closes.length < 120) closes.push(101);
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

describe("R6 golden replay determinism criterion", () => {
  it("drives two safety orders then the take-profit and is byte-identical across runs", async () => {
    const candles = goldenCandles();
    const first = await drive(candles, botConfig());
    const second = await drive(candles, botConfig());

    // Byte-identical event streams: the determinism release gate.
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(JSON.stringify(first.journal)).toBe(JSON.stringify(second.journal));
    expect(JSON.stringify(first.dcaSnapshot)).toBe(JSON.stringify(second.dcaSnapshot));

    // The fixture path exercises exactly base + 2 SOs + full TP close.
    const executed = fills(first.events);
    expect(executed.filter((fill) => fill.kind === "open" && fill.reason === "dca:base").length).toBe(1);
    expect(executed.filter((fill) => fill.kind === "open" && fill.reason === "trigger:limit").length).toBe(2);
    expect(executed.filter((fill) => fill.kind === "close").length).toBe(1);
    expect(first.finalState.position).toBeNull();
    expect(first.dcaSnapshot?.state).toMatchObject({ phase: "cooldown", cycle: 1, qty: 0 });

    // Full TP close: the machine's six-decimal arithmetic leaves no dust.
    const close = executed.find((fill) => fill.kind === "close");
    const opens = executed.filter((fill) => fill.kind === "open");
    expect(close?.qty).toBe(opens.reduce((sum, fill) => sum + fill.qty, 0));
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

  it("resumes mid-cycle from durable artifacts to the identical terminal state", async () => {
    const candles = goldenCandles();
    const uninterrupted = await drive(candles, botConfig());

    // Restart between SO1 and SO2, while the position is open mid-cycle.
    const splitIndex = 25;
    const before = await drive(candles.slice(0, splitIndex), botConfig());
    expect(before.dcaSnapshot?.state).toMatchObject({ phase: "position", soFilled: 1 });
    const resumed = await drive(candles.slice(splitIndex), botConfig(), {
      resume: {
        ledgerEvents: before.events,
        dcaSnapshot: before.dcaSnapshot,
        journal: before.journal
      }
    });

    expect(JSON.stringify(resumed.events)).toBe(JSON.stringify(uninterrupted.events));
    expect(resumed.finalState).toEqual(uninterrupted.finalState);
    expect(resumed.projection).toEqual(uninterrupted.projection);
    expect(resumed.dcaSnapshot?.state).toEqual(uninterrupted.dcaSnapshot?.state);
  });

  it("never exceeds the reserved worst case and never overdraws the balance", async () => {
    const result = await drive(goldenCandles(), botConfig());
    const worstCase = worstCaseDcaCapitalQuote(DCA_PARAMS, PAPER_FILL_MODEL_V1.feePct);
    expect(worstCase).toBe(400.2);
    expect(worstCase).toBeLessThanOrEqual(START_BALANCE);

    const path = capitalPath(result.events);
    expect(path.minBalance).toBeGreaterThanOrEqual(0);
    expect(path.maxCommitted).toBeGreaterThan(0);
    expect(path.maxCommitted).toBeLessThanOrEqual(worstCase);
    expect(path.balance).toBe(result.finalState.balance);
  });

  it("fails closed on malformed candle paths and non-dca configs", async () => {
    const candles = goldenCandles();
    await expect(drive([candles[0]!, candles[0]!], botConfig())).rejects.toThrow(/ascending/);
    await expect(drive([{ ...candles[0]!, low: 200 }], botConfig())).rejects.toThrow(/well-formed/);
    const strategy = { ...botConfig(), kind: undefined, dca: undefined };
    await expect(drive(candles, strategy)).rejects.toThrow(/R7/);
  });
});
