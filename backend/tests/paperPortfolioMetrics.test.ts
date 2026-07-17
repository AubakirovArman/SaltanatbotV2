import { describe, expect, it } from "vitest";
import { PaperAdapter, type PaperExecutionQuote, type VerifiedPaperFundingSettlement } from "../src/trading/exchange/paper.js";
import { stampPaperLedgerEvent, type PaperLedgerEvent } from "../src/trading/paperLedger.js";
import { projectPaperPortfolio } from "../src/trading/paperPortfolioMetrics.js";
import {
  PAPER_METRICS_FORMULA_VERSION,
  PAPER_PORTFOLIO_SCHEMA_VERSION,
  type PaperDurableMarkInput,
  type PaperMoney,
  type PaperPortfolioProjectionInput,
  type PaperRobotProjectionInput
} from "../src/trading/paperPortfolioTypes.js";
import type { ExecOrder, PendingOrder, PositionState, Side } from "../src/trading/types.js";

const START = 1_800_000_000_000;
const OWNER = "owner-1";
const PORTFOLIO = "portfolio-1";
const EPOCH = 3;

function amount(value: number): PaperMoney {
  return value.toFixed(6);
}

function context(robots: PaperRobotProjectionInput[], overrides: Partial<PaperPortfolioProjectionInput> = {}): PaperPortfolioProjectionInput {
  const unallocatedCash = overrides.unallocatedCash ?? "0.000000";
  const activeAllocations = robots
    .filter((robot) => robot.allocationStatus === "active")
    .reduce((total, robot) => total + Number.parseFloat(robot.allocation), 0);
  return {
    schemaVersion: PAPER_PORTFOLIO_SCHEMA_VERSION,
    formulaVersion: PAPER_METRICS_FORMULA_VERSION,
    ownerUserId: OWNER,
    portfolioId: PORTFOLIO,
    ledgerEpoch: EPOCH,
    epochStartedAt: START,
    asOf: START + 10_000,
    markFreshnessMs: 2_000,
    initialCapital: amount(activeAllocations + Number.parseFloat(unallocatedCash)),
    unallocatedCash,
    robots,
    ...overrides
  };
}

function robot(
  botId: string,
  allocation: number,
  ledgerEvents: PaperLedgerEvent[],
  currentMarks: PaperDurableMarkInput[] = [],
  market: PaperRobotProjectionInput["market"] = "futures",
  allocationStatus: PaperRobotProjectionInput["allocationStatus"] = "active"
): PaperRobotProjectionInput {
  return {
    ownerUserId: OWNER,
    portfolioId: PORTFOLIO,
    ledgerEpoch: EPOCH,
    botId,
    botRevision: 7,
    market,
    allocationStatus,
    allocation: amount(allocation),
    ledgerEvents,
    currentMarks
  };
}

function mark(botId: string, symbol: string, price: number, observedAt = START + 9_000): PaperDurableMarkInput {
  return {
    ownerUserId: OWNER,
    portfolioId: PORTFOLIO,
    ledgerEpoch: EPOCH,
    botId,
    botRevision: 7,
    symbol,
    price: amount(price),
    observedAt,
    expiresAt: observedAt + 2_000,
    persistedAt: observedAt + 100,
    source: "durable-test-mark",
    durable: true
  };
}

function initEvent(botId: string, allocation: number, ts = START, epoch = EPOCH): PaperLedgerEvent {
  return stampPaperLedgerEvent(
    botId,
    epoch,
    1,
    { type: "account_initialized", data: { balance: allocation, leverage: 1, isolated: false, dualSide: false } },
    ts,
    `${botId}-init`,
    "account-initialized"
  );
}

function positionEvent(botId: string, position: PositionState, sequence = 2): PaperLedgerEvent {
  return stampPaperLedgerEvent(botId, EPOCH, sequence, { type: "position", data: { position } }, START + sequence * 1_000, `${botId}-position-${sequence}`);
}

function orderEvent(botId: string, order: PendingOrder, sequence = 2): PaperLedgerEvent {
  return stampPaperLedgerEvent(botId, EPOCH, sequence, { type: "order_upserted", data: { order } }, START + sequence * 1_000, `${botId}-order-${sequence}`);
}

function longPosition(symbol = "BTCUSDT"): PositionState {
  return { symbol, side: "long", qty: 1, entryPrice: 100, leverage: 1, openedAt: START + 1_000 };
}

function deterministicAdapter(botId: string): {
  adapter: PaperAdapter;
  setQuote: (next: PaperExecutionQuote) => void;
  setTime: (next: number) => void;
} {
  let now = START;
  let quote: PaperExecutionQuote = { price: 100, availableQty: 2, source: "depth-test", verified: true };
  let id = 0;
  return {
    adapter: new PaperAdapter({
      botId,
      ledgerEpoch: EPOCH,
      market: "futures",
      startBalance: 10_000,
      feePct: 0.1,
      slipPct: 0,
      getPrice: () => quote.price,
      getExecutionQuote: () => quote,
      now: () => now,
      createId: () => `${botId}-event-${++id}`
    }),
    setQuote: (next) => { quote = next; },
    setTime: (next) => { now = next; }
  };
}

function order(action: ExecOrder["action"], side: Side, qty: number): ExecOrder {
  return { action, market: "futures", symbol: "BTCUSDT", side, qty, type: "market", reason: "portfolio-golden" };
}

describe("paper portfolio metrics", () => {
  it("projects a deterministic golden ledger with exact cash and fresh-mark metrics", async () => {
    const fixture = deterministicAdapter("golden-bot");
    fixture.setTime(START + 1_000);
    await fixture.adapter.execute(order("open", "buy", 2));
    fixture.setQuote({ price: 110, availableQty: 1, source: "depth-test", verified: true });
    fixture.setTime(START + 2_000);
    await fixture.adapter.execute(order("close", "sell", 1));
    const settlement: VerifiedPaperFundingSettlement = {
      settlementId: "funding-golden",
      symbol: "BTCUSDT",
      rate: 0.01,
      markPrice: 105,
      settledAt: START + 3_000,
      source: "funding-test",
      verified: true
    };
    fixture.adapter.applyFundingSettlement(settlement);

    const result = projectPaperPortfolio(context([
      robot("golden-bot", 10_000, fixture.adapter.getLedgerEvents(), [mark("golden-bot", "BTCUSDT", 120)])
    ]));
    const metrics = result.robots[0].metrics;

    expect(result).toMatchObject({
      schemaVersion: "paper-portfolio-v1",
      formulaVersion: "paper-metrics-v1",
      ledgerEpoch: EPOCH,
      aggregates: {
        cashBalance: "10008.640000",
        feesPaid: "0.310000",
        fundingNet: "-1.050000",
        realizedNetCashPnl: "9.690000",
        cashEventMaxDrawdown: "1.050000"
      },
      cashConservation: { balanced: true, difference: "0.000000" }
    });
    expect(metrics).toMatchObject({
      cashBalance: "10008.640000",
      unrealizedPnl: { status: "available", value: "20.000000" },
      grossExposure: { status: "available", value: "120.000000" },
      netExposure: { status: "available", value: "120.000000" },
      equity: { status: "available", value: "10028.640000" },
      reservedCapital: "10000.000000",
      committedCapital: { status: "available", value: "120.000000" },
      margin: { status: "available", value: "120.000000" },
      borrowing: { status: "unavailable", reason: "not_modeled_in_paper_portfolio_v1" },
      tradeStatistics: {
        closedTrades: 1,
        winningTrades: 1,
        winRate: { status: "available", value: 1 },
        profitFactor: { status: "unavailable", reason: "no_losing_trades" },
        expectancy: { status: "available", value: "9.890000" }
      }
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("labels stale and missing marks without manufacturing valuation zeros", () => {
    const staleEvents = [initEvent("stale-bot", 1_000), positionEvent("stale-bot", longPosition())];
    const missingEvents = [initEvent("missing-bot", 1_000), positionEvent("missing-bot", longPosition())];
    const result = projectPaperPortfolio(context([
      robot("stale-bot", 1_000, staleEvents, [mark("stale-bot", "BTCUSDT", 120, START + 7_999)]),
      robot("missing-bot", 1_000, missingEvents)
    ]));

    expect(result.robots.find((value) => value.botId === "stale-bot")?.positions[0]).toMatchObject({
      markPrice: { status: "stale", lastValue: "120.000000", staleByMs: 1 },
      unrealizedPnl: { status: "unavailable", reason: "fresh_mark_required" }
    });
    expect(result.robots.find((value) => value.botId === "missing-bot")?.positions[0]).toMatchObject({
      markPrice: { status: "unavailable", reason: "mark_missing" },
      grossExposure: { status: "unavailable", reason: "fresh_mark_required" }
    });
    expect(result.aggregates).toMatchObject({
      unrealizedPnl: { status: "unavailable" },
      equity: { status: "unavailable" },
      reservedCapital: "2000.000000",
      committedCapital: { status: "unavailable" },
      margin: { status: "unavailable" }
    });
  });

  it("keeps proven flat zeros but makes no-trade ratios mathematically unavailable", () => {
    const result = projectPaperPortfolio(context([robot("idle-bot", 1_000, [initEvent("idle-bot", 1_000)])]));
    expect(result.robots[0]).toMatchObject({
      runtimeState: "idle",
      positions: [],
      openOrders: [],
      metrics: {
        unrealizedPnl: { status: "available", value: "0.000000" },
        grossExposure: { status: "available", value: "0.000000" },
        tradeStatistics: {
          closedTrades: 0,
          grossProfit: "0.000000",
          winRate: { status: "unavailable", reason: "no_closed_trades" },
          profitFactor: { status: "unavailable", reason: "no_closed_trades" },
          expectancy: { status: "unavailable", reason: "no_closed_trades" }
        }
      }
    });
  });

  it("dates aggregate evidence by its oldest required observation", () => {
    const botId = "evidence-time-bot";
    const events = [
      initEvent(botId, 1_000),
      positionEvent(botId, longPosition(), 2),
      stampPaperLedgerEvent(
        botId,
        EPOCH,
        3,
        {
          type: "settings",
          data: { leverage: 1, isolated: false, dualSide: false }
        },
        START + 10_000,
        `${botId}-settings`
      )
    ];
    const result = projectPaperPortfolio(context([
      robot(botId, 1_000, events, [mark(botId, "BTCUSDT", 120, START + 9_000)])
    ]));

    expect(result.robots[0].metrics.committedCapital).toMatchObject({
      status: "available",
      observedAt: START + 9_000
    });
    expect(result.aggregates.committedCapital).toMatchObject({
      status: "available",
      observedAt: START + 9_000
    });
  });

  it("conserves allocations, unallocated cash, positions, orders and reserved capital", () => {
    const positionBot = [initEvent("position-bot", 1_000), positionEvent("position-bot", longPosition())];
    const pending: PendingOrder = {
      id: "entry-order",
      symbol: "ETHUSDT",
      side: "buy",
      type: "limit",
      qty: 2,
      price: 50,
      reduceOnly: false,
      tif: "GTC",
      createdAt: START + 2_000
    };
    const orderBot = [initEvent("order-bot", 2_000), orderEvent("order-bot", pending)];
    const result = projectPaperPortfolio(context([
      robot("position-bot", 1_000, positionBot, [mark("position-bot", "BTCUSDT", 120)]),
      robot("order-bot", 2_000, orderBot)
    ], { unallocatedCash: "500.000000" }));

    expect(result.aggregates).toMatchObject({
      allocatedCapital: "3000.000000",
      unallocatedCash: "500.000000",
      initialCapital: "3500.000000",
      cashBalance: "3500.000000",
      unrealizedPnl: { status: "available", value: "20.000000" },
      equity: { status: "available", value: "3520.000000" },
      reservedCapital: "3000.000000",
      availableCapital: "500.000000",
      committedCapital: { status: "available", value: "220.000000" },
      margin: { status: "available", value: "220.000000" },
      borrowing: { status: "unavailable", reason: "not_modeled_in_paper_portfolio_v1" }
    });
    expect(result.positions).toHaveLength(1);
    expect(result.openOrders).toHaveLength(1);
    expect(result.openOrders[0]).toMatchObject({
      referencePrice: { status: "available", value: "50.000000" },
      committedCapital: { status: "available", value: "100.000000" }
    });
    expect(result.cashConservation).toEqual({
      expectedCashBalance: "3500.000000",
      actualCashBalance: "3500.000000",
      difference: "0.000000",
      balanced: true
    });
  });

  it("keeps spot commitment separate from futures margin and never invents borrowing", () => {
    const events = [initEvent("spot-bot", 1_000), positionEvent("spot-bot", longPosition())];
    const result = projectPaperPortfolio(context([
      robot("spot-bot", 1_000, events, [mark("spot-bot", "BTCUSDT", 120)], "spot")
    ]));

    expect(result.robots[0].metrics).toMatchObject({
      reservedCapital: "1000.000000",
      committedCapital: { status: "available", value: "120.000000" },
      margin: { status: "unavailable", reason: "not_applicable_spot" },
      borrowing: { status: "unavailable", reason: "not_modeled_in_paper_portfolio_v1" }
    });
    expect(result.robots[0].positions[0]).toMatchObject({
      committedCapital: { status: "available", value: "120.000000" },
      positionMargin: { status: "unavailable", reason: "not_applicable_spot" }
    });
    expect(result.aggregates).toMatchObject({
      reservedCapital: "1000.000000",
      committedCapital: { status: "available", value: "120.000000" },
      margin: { status: "available", value: "0.000000" },
      borrowing: { status: "unavailable", reason: "not_modeled_in_paper_portfolio_v1" }
    });
  });

  it("is identical after restart, input reordering and exact event redelivery", async () => {
    const fixture = deterministicAdapter("restart-bot");
    fixture.setTime(START + 1_000);
    await fixture.adapter.execute(order("open", "buy", 1));
    const events = fixture.adapter.getLedgerEvents();
    const normal = projectPaperPortfolio(context([
      robot("restart-bot", 10_000, events, [mark("restart-bot", "BTCUSDT", 101)])
    ]));
    const replayed = projectPaperPortfolio(context([
      robot("restart-bot", 10_000, [...events].reverse().concat(structuredClone(events[0])), [mark("restart-bot", "BTCUSDT", 101)])
    ]));

    expect(replayed).toEqual(normal);
  });

  it("preserves epoch profit after a flat robot releases its capital", async () => {
    const fixture = deterministicAdapter("released-bot");
    fixture.setTime(START + 1_000);
    await fixture.adapter.execute(order("open", "buy", 1));
    fixture.setQuote({ price: 110, availableQty: 1, source: "depth-test", verified: true });
    fixture.setTime(START + 2_000);
    await fixture.adapter.execute(order("close", "sell", 1));
    const returnedCash = amount(fixture.adapter.getState().balance);

    const result = projectPaperPortfolio(context([
      robot("released-bot", 10_000, fixture.adapter.getLedgerEvents(), [], "futures", "released")
    ], {
      initialCapital: "10000.000000",
      unallocatedCash: returnedCash
    }));

    expect(result.robots[0]).toMatchObject({
      allocationStatus: "released",
      runtimeState: "idle",
      metrics: {
        cashBalance: returnedCash,
        reservedCapital: "0.000000",
        realizedNetCashPnl: "9.790000"
      }
    });
    expect(result.aggregates).toMatchObject({
      allocatedCapital: "0.000000",
      unallocatedCash: returnedCash,
      initialCapital: "10000.000000",
      cashBalance: returnedCash,
      realizedNetCashPnl: "9.790000",
      reservedCapital: "0.000000",
      availableCapital: returnedCash
    });
    expect(result.cashConservation).toEqual({
      expectedCashBalance: returnedCash,
      actualCashBalance: returnedCash,
      difference: "0.000000",
      balanced: true
    });
  });

  it("fails closed on owner, revision, bot, epoch and allocation identity mismatches", () => {
    const events = [initEvent("identity-bot", 1_000)];
    const valid = robot("identity-bot", 1_000, events, [mark("identity-bot", "BTCUSDT", 100)]);
    expect(() => projectPaperPortfolio(context([{ ...valid, ownerUserId: "another-owner" }]))).toThrow(/identity does not match/i);
    expect(() => projectPaperPortfolio(context([{ ...valid, currentMarks: [{ ...valid.currentMarks[0], botRevision: 8 }] }]))).toThrow(/mark identity/i);
    expect(() => projectPaperPortfolio(context([{ ...valid, ledgerEvents: [initEvent("another-bot", 1_000)] }]))).toThrow(/belongs to another-bot/i);
    expect(() => projectPaperPortfolio(context([{ ...valid, ledgerEvents: [initEvent("identity-bot", 1_000, START, EPOCH + 1)] }]))).toThrow(/ledger epoch/i);
    expect(() => projectPaperPortfolio(context([{ ...valid, allocation: "999.000000" }]))).toThrow(/allocation does not match/i);
    expect(() => projectPaperPortfolio(context([{ ...valid, allocation: "1000" as PaperMoney }]))).toThrow(/canonical bot allocation/i);
  });
});
