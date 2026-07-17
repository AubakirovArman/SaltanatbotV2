import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperLedgerEvent } from "../src/trading/paperLedger.js";
import { appendPaperLedgerEventsTo } from "../src/trading/paperLedgerStore.js";
import { PaperPortfolioReadService } from "../src/trading/paperPortfolioReadService.js";
import {
  createPaperPortfolioIn,
  releaseFlatPaperBotAllocationIn,
  reserveAndBindPaperBotIn
} from "../src/trading/paperPortfolioStore.js";
import {
  PAPER_ROBOT_CURVE_POINT_LIMIT,
  PAPER_ROBOT_RECENT_EVENT_LIMIT,
  PAPER_ROBOT_RECENT_FILL_LIMIT
} from "../src/trading/paperRobotJournal.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import type { BotConfig, FillRecord } from "../src/trading/types.js";

const NOW = 1_900_000_000_000;
const OWNER = "journal-owner";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const databases: DatabaseSync[] = [];

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  databases.push(value);
  migrateTradingStore(value, () => NOW, { legacyOwnerUserId: OWNER });
  return value;
}

function paperBot(id: string): BotConfig {
  return {
    id,
    ownerUserId: OWNER,
    accountId: `paper:${id}`,
    name: "Journal bot",
    strategyName: "Journal strategy",
    ir: { name: "journal", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: NOW,
    updatedAt: NOW
  };
}

function fixture(value: DatabaseSync, botId = "journal-bot", allocationMicros = 1_000_000_000) {
  const portfolio = createPaperPortfolioIn(value, OWNER, {
    mutationId: `create-${botId}`,
    idempotencyKey: `create-key-${botId}`,
    requestHash: HASH_A,
    now: NOW,
    portfolioId: `portfolio-${botId}`,
    name: "Journal portfolio",
    initialCapitalMicros: 10_000_000_000,
    makeDefault: true
  });
  const bot = upsertBotIntoForOwner(value, OWNER, paperBot(botId));
  const binding = reserveAndBindPaperBotIn(value, OWNER, {
    mutationId: `bind-${botId}`,
    idempotencyKey: `bind-key-${botId}`,
    requestHash: HASH_B,
    now: NOW + 1,
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId,
    expectedBotRevision: bot.revision!,
    allocationMicros
  });
  return { portfolio: binding.portfolio, allocation: binding.allocation };
}

function service(value: DatabaseSync): PaperPortfolioReadService {
  return new PaperPortfolioReadService(value, { isRunning: () => false, isPaused: () => false });
}

function fillEvent(botId: string, sequence: number, fill: FillRecord): PaperLedgerEvent {
  return {
    id: `event-fill-${botId}-${sequence}`,
    botId,
    ledgerEpoch: 1,
    sequence,
    type: "fill",
    data: { fill },
    ts: fill.ts
  };
}

function feeEvent(botId: string, sequence: number, fill: FillRecord): PaperLedgerEvent {
  return {
    id: `event-fee-${botId}-${sequence}`,
    botId,
    ledgerEpoch: 1,
    sequence,
    type: "fee",
    data: { fillId: fill.id, amount: fill.fee, asset: fill.feeAsset ?? "USDT" },
    ts: fill.ts
  };
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("paper robot journal read evidence", () => {
  it("exposes exact realized cash, safe fill/event summaries and available current equity", () => {
    const value = database();
    const bound = fixture(value);
    const fill: FillRecord = {
      id: "fill-safe-summary",
      botId: bound.allocation.botId,
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.5,
      price: 250.125,
      fee: 0.125,
      feeAsset: "USDT",
      realizedPnl: 0,
      kind: "open",
      reason: "must-not-leak-fill-reason",
      ts: NOW + 2
    };
    appendPaperLedgerEventsTo(value, [
      fillEvent(bound.allocation.botId, 2, fill),
      feeEvent(bound.allocation.botId, 3, fill),
      {
        id: "event-command-result",
        botId: bound.allocation.botId,
        ledgerEpoch: 1,
        sequence: 4,
        type: "command_completed",
        idempotencyKey: "command:command-secret:result",
        data: {
          commandId: "command-secret",
          requestHash: "d".repeat(64),
          result: { ok: true, message: "must-not-leak-command-payload", fills: [] }
        },
        ts: NOW + 3
      }
    ]);

    const detail = service(value).detail(OWNER, bound.portfolio.id, NOW + 10);
    const journal = detail.robots[0]!.journal;
    expect(journal).toMatchObject({
      schemaVersion: "paper-robot-journal-v1",
      ownerUserId: OWNER,
      portfolioId: bound.portfolio.id,
      ledgerEpoch: 1,
      botId: bound.allocation.botId,
      botRevision: bound.allocation.botRevision,
      curve: {
        formulaVersion: "paper-realized-cash-curve-v1",
        basis: "current-epoch-realized-cash",
        pointOrder: "oldest-first",
        truncated: false,
        sourceCashPointCount: 2,
        points: [
          { basis: "cash-realized", sequence: 1, cashBalance: "1000.000000", realizedNetCashPnl: "0.000000" },
          { basis: "cash-realized", sequence: 3, cashBalance: "999.875000", realizedNetCashPnl: "-0.125000" },
          { basis: "current-equity", afterSequence: 4, ts: NOW + 3, equity: "999.875000" }
        ]
      },
      recentFills: {
        order: "newest-first",
        truncated: false,
        items: [{
          fillId: fill.id,
          sequence: 2,
          price: "250.125000",
          fee: "0.125000",
          realizedPnl: "0.000000"
        }]
      },
      recentEvents: {
        order: "newest-first",
        truncated: false,
        items: [
          { eventId: "event-command-result", sequence: 4, type: "command_completed" },
          { sequence: 3, type: "fee" },
          { sequence: 2, type: "fill" },
          { sequence: 1, type: "account_initialized" }
        ]
      }
    });
    expect(JSON.stringify(journal)).not.toContain("must-not-leak");
    expect(journal.recentEvents.items.every((event) => !Reflect.has(event, "data"))).toBe(true);
    expect(journal.recentEvents.items.every((event) => !Reflect.has(event, "idempotencyKey"))).toBe(true);
    expect(() => service(value).detail("foreign-owner", bound.portfolio.id, NOW + 10)).toThrow(/not found/i);
  });

  it("applies fee, funding and realized cash with the canonical ledger formula", () => {
    const value = database();
    const bound = fixture(value, "accounting-bot");
    const close: FillRecord = {
      id: "accounting-close",
      botId: bound.allocation.botId,
      symbol: "BTCUSDT",
      side: "sell",
      qty: 1,
      price: 110,
      fee: 0.11,
      feeAsset: "USDT",
      realizedPnl: 9.89,
      kind: "close",
      reason: "accounting-test",
      ts: NOW + 4
    };
    appendPaperLedgerEventsTo(value, [
      {
        id: "accounting-position-open",
        botId: bound.allocation.botId,
        ledgerEpoch: 1,
        sequence: 2,
        type: "position",
        data: { position: { symbol: "BTCUSDT", side: "long", qty: 1, entryPrice: 100, leverage: 1, openedAt: NOW + 2 } },
        ts: NOW + 2
      },
      {
        id: "accounting-funding",
        botId: bound.allocation.botId,
        ledgerEpoch: 1,
        sequence: 3,
        type: "funding",
        idempotencyKey: "funding:accounting-settlement",
        data: {
          settlementId: "accounting-settlement",
          symbol: "BTCUSDT",
          rate: 0.001,
          markPrice: 100,
          positionQty: 1,
          amount: -0.1,
          source: "verified-test-funding",
          settledAt: NOW + 3,
          verified: true
        },
        ts: NOW + 3
      },
      fillEvent(bound.allocation.botId, 4, close),
      feeEvent(bound.allocation.botId, 5, close),
      {
        id: "accounting-realized-cash",
        botId: bound.allocation.botId,
        ledgerEpoch: 1,
        sequence: 6,
        type: "cash",
        data: { amount: 10, reason: "realized-pnl", fillId: close.id },
        ts: NOW + 4
      },
      {
        id: "accounting-position-flat",
        botId: bound.allocation.botId,
        ledgerEpoch: 1,
        sequence: 7,
        type: "position",
        data: { position: null },
        ts: NOW + 4
      }
    ]);

    const detail = service(value).detail(OWNER, bound.portfolio.id, NOW + 10);
    expect(detail.snapshot.robots[0]!.metrics).toMatchObject({
      cashBalance: "1009.790000",
      feesPaid: "0.110000",
      fundingNet: "-0.100000",
      realizedNetCashPnl: "9.890000",
      cashEventMaxDrawdown: "0.100000",
      tradeStatistics: { closedTrades: 1, winningTrades: 1, grossProfit: "9.890000" }
    });
    expect(detail.robots[0]!.journal.curve.points).toEqual([
      expect.objectContaining({ basis: "cash-realized", sequence: 1, cashBalance: "1000.000000", realizedNetCashPnl: "0.000000" }),
      expect.objectContaining({ basis: "cash-realized", sequence: 3, cashBalance: "999.900000", realizedNetCashPnl: "0.000000" }),
      expect.objectContaining({ basis: "cash-realized", sequence: 5, cashBalance: "999.790000", realizedNetCashPnl: "-0.110000" }),
      expect.objectContaining({ basis: "cash-realized", sequence: 6, cashBalance: "1009.790000", realizedNetCashPnl: "9.890000" }),
      expect.objectContaining({ basis: "current-equity", afterSequence: 7, equity: "1009.790000" })
    ]);
  });

  it("omits current equity without mark evidence and retains released robot history", () => {
    const value = database();
    const open = fixture(value, "open-bot");
    appendPaperLedgerEventsTo(value, [{
      id: "open-position-event",
      botId: open.allocation.botId,
      ledgerEpoch: 1,
      sequence: 2,
      type: "position",
      data: {
        position: {
          symbol: "BTCUSDT",
          side: "long",
          qty: 1,
          entryPrice: 100,
          leverage: 1,
          openedAt: NOW + 2
        }
      },
      ts: NOW + 2
    }]);
    const withoutMark = service(value).detail(OWNER, open.portfolio.id, NOW + 10);
    expect(withoutMark.snapshot.robots[0]!.metrics.equity).toMatchObject({ status: "unavailable" });
    expect(withoutMark.robots[0]!.journal.curve.points).toEqual([
      expect.objectContaining({ basis: "cash-realized", sequence: 1, cashBalance: "1000.000000" })
    ]);

    const released = fixture(value, "released-bot");
    const result = releaseFlatPaperBotAllocationIn(value, OWNER, {
      mutationId: "release-history",
      idempotencyKey: "release-history-key",
      requestHash: HASH_C,
      now: NOW + 4,
      portfolioId: released.portfolio.id,
      expectedRevision: released.portfolio.revision,
      expectedLedgerEpoch: released.portfolio.currentEpoch,
      evidence: {
        botId: released.allocation.botId,
        botRevision: released.allocation.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: 1_000_000_000,
        checkedAt: NOW + 3,
        source: "journal-release-test",
        verified: true
      }
    });
    const releasedDetail = service(value).detail(OWNER, result.portfolio.id, NOW + 10);
    expect(releasedDetail.snapshot.robots[0]!.allocationStatus).toBe("released");
    expect(releasedDetail.robots[0]!.journal).toMatchObject({
      botId: released.allocation.botId,
      ledgerEpoch: 1,
      curve: { sourceCashPointCount: 1 },
      recentEvents: { items: [{ type: "account_initialized" }] }
    });
  });

  it("deterministically caps dense journals across read-service restarts", () => {
    const value = database();
    const bound = fixture(value, "dense-bot", 10_000_000_000);
    const events: PaperLedgerEvent[] = [];
    for (let index = 0; index < 300; index += 1) {
      const fillSequence = 2 + index * 2;
      const fill: FillRecord = {
        id: `dense-fill-${index}`,
        botId: bound.allocation.botId,
        symbol: "BTCUSDT",
        side: "buy",
        qty: 0.001,
        price: 100,
        fee: 0.001,
        feeAsset: "USDT",
        realizedPnl: 0,
        kind: "open",
        reason: "dense-test",
        ts: NOW + 2 + index
      };
      events.push(fillEvent(bound.allocation.botId, fillSequence, fill));
      events.push(feeEvent(bound.allocation.botId, fillSequence + 1, fill));
    }
    appendPaperLedgerEventsTo(value, events);

    const first = service(value).detail(OWNER, bound.portfolio.id, NOW + 1_000).robots[0]!.journal;
    const afterRestart = service(value).detail(OWNER, bound.portfolio.id, NOW + 2_000).robots[0]!.journal;
    expect(afterRestart).toEqual(first);
    expect(first.curve.points).toHaveLength(PAPER_ROBOT_CURVE_POINT_LIMIT);
    expect(first.curve).toMatchObject({ truncated: true, sourceCashPointCount: 301 });
    expect(first.curve.points[0]).toMatchObject({ basis: "cash-realized", sequence: 1 });
    expect(first.curve.points.at(-2)).toMatchObject({ basis: "cash-realized", sequence: 601, cashBalance: "9999.700000" });
    expect(first.curve.points.at(-1)).toMatchObject({ basis: "current-equity", afterSequence: 601, equity: "9999.700000" });
    expect(first.recentFills.items).toHaveLength(PAPER_ROBOT_RECENT_FILL_LIMIT);
    expect(first.recentFills.truncated).toBe(true);
    expect(first.recentFills.items[0]).toMatchObject({ fillId: "dense-fill-299", sequence: 600 });
    expect(first.recentEvents.items).toHaveLength(PAPER_ROBOT_RECENT_EVENT_LIMIT);
    expect(first.recentEvents.truncated).toBe(true);
    expect(first.recentEvents.items[0]).toMatchObject({ sequence: 601, type: "fee" });
  });
});
