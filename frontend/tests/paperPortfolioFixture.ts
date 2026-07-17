import type {
  EvidenceValue,
  PaperMoney,
  PaperPortfolioDetail,
  PaperPortfolioListResponse,
  PaperPortfolioProjection,
  PaperRobotJournal
} from "../src/trading/paperPortfolioTypes";

export const ownerUserId = "11111111-1111-4111-8111-111111111111";
export const portfolioId = "portfolio-1";
export const money = (value: string): PaperMoney => value;

const availableMoney = (value: string): EvidenceValue<PaperMoney> => ({
  status: "available",
  value: money(value),
  observedAt: 1_720_000_000_000,
  source: "paper-ledger"
});
const unavailableMoney = (reason: string): EvidenceValue<PaperMoney> => ({ status: "unavailable", reason });
const unavailableNumber = (reason: string): EvidenceValue<number> => ({ status: "unavailable", reason });

const statistics = {
  closedTrades: 2,
  winningTrades: 1,
  losingTrades: 1,
  breakevenTrades: 0,
  grossProfit: money("25.000000"),
  grossLoss: money("-10.000000"),
  winRate: { status: "available", value: 0.5, observedAt: 1_720_000_000_000, source: "paper-ledger" } as const,
  profitFactor: { status: "available", value: 2.5, observedAt: 1_720_000_000_000, source: "paper-ledger" } as const,
  expectancy: unavailableMoney("Insufficient sample")
};

const metrics = {
  cashBalance: money("1015.000000"),
  feesPaid: money("2.000000"),
  fundingNet: money("0.000000"),
  realizedNetCashPnl: money("15.000000"),
  legacyCashAdjustments: money("0.000000"),
  cashEventMaxDrawdown: money("-10.000000"),
  unrealizedPnl: availableMoney("5.000000"),
  grossExposure: availableMoney("200.000000"),
  netExposure: availableMoney("200.000000"),
  equity: availableMoney("1020.000000"),
  reservedCapital: money("1000.000000"),
  committedCapital: availableMoney("200.000000"),
  margin: unavailableMoney("Paper margin model is not available"),
  borrowing: unavailableMoney("Paper borrowing model is not available"),
  tradeStatistics: statistics
};

const cashConservation = {
  expectedCashBalance: money("1015.000000"),
  actualCashBalance: money("1015.000000"),
  difference: money("0.000000"),
  balanced: true as const
};

export const projection: PaperPortfolioProjection = {
  schemaVersion: "paper-portfolio-v1",
  formulaVersion: "paper-metrics-v1",
  ownerUserId,
  portfolioId,
  ledgerEpoch: 1,
  epochStartedAt: 1_719_000_000_000,
  asOf: 1_720_000_000_000,
  robots: [{
    ownerUserId,
    portfolioId,
    ledgerEpoch: 1,
    botId: "bot-1",
    botRevision: 3,
    market: "futures",
    allocation: money("1000.000000"),
    allocationStatus: "active",
    runtimeState: "position_open",
    ledger: { eventCount: 5, lastSequence: 5, observedAt: 1_720_000_000_000 },
    metrics,
    positions: [{
      ownerUserId,
      portfolioId,
      ledgerEpoch: 1,
      botId: "bot-1",
      botRevision: 3,
      symbol: "BTCUSDT",
      side: "long",
      qty: 0.01,
      entryPrice: money("65000.000000"),
      leverage: 2,
      openedAt: 1_719_500_000_000,
      markPrice: availableMoney("65500.000000"),
      unrealizedPnl: availableMoney("5.000000"),
      grossExposure: availableMoney("655.000000"),
      netExposure: availableMoney("655.000000"),
      committedCapital: availableMoney("200.000000"),
      positionMargin: unavailableMoney("Paper margin model is not available")
    }],
    openOrders: [],
    cashConservation
  }],
  positions: [],
  openOrders: [],
  aggregates: {
    allocatedCapital: money("1000.000000"),
    unallocatedCash: money("9000.000000"),
    initialCapital: money("10000.000000"),
    cashBalance: money("10015.000000"),
    feesPaid: money("2.000000"),
    fundingNet: money("0.000000"),
    realizedNetCashPnl: money("15.000000"),
    legacyCashAdjustments: money("0.000000"),
    cashEventMaxDrawdown: money("-10.000000"),
    unrealizedPnl: availableMoney("5.000000"),
    grossExposure: availableMoney("655.000000"),
    netExposure: availableMoney("655.000000"),
    equity: availableMoney("10020.000000"),
    reservedCapital: money("1000.000000"),
    availableCapital: money("9000.000000"),
    committedCapital: availableMoney("200.000000"),
    margin: unavailableMoney("Paper margin model is not available"),
    borrowing: unavailableMoney("Paper borrowing model is not available"),
    tradeStatistics: { ...statistics, profitFactor: unavailableNumber("No losing trades") }
  },
  cashConservation: {
    expectedCashBalance: money("10015.000000"),
    actualCashBalance: money("10015.000000"),
    difference: money("0.000000"),
    balanced: true
  }
};

export const portfolio = {
  ownerUserId,
  id: portfolioId,
  name: "Main paper",
  status: "active" as const,
  currency: "USDT" as const,
  revision: 4,
  currentEpoch: 1,
  isDefault: true,
  createdAt: 1_719_000_000_000,
  updatedAt: 1_720_000_000_000
};

export const listResponse: PaperPortfolioListResponse = {
  schemaVersion: "paper-portfolio-list-v1",
  asOf: projection.asOf,
  portfolios: [portfolio]
};

export const journal: PaperRobotJournal = {
  schemaVersion: "paper-robot-journal-v1",
  ownerUserId,
  portfolioId,
  ledgerEpoch: 1,
  botId: "bot-1",
  botRevision: 3,
  curve: {
    formulaVersion: "paper-realized-cash-curve-v1",
    basis: "current-epoch-realized-cash",
    pointOrder: "oldest-first",
    truncated: false,
    sourceCashPointCount: 3,
    points: [
      { basis: "cash-realized", sequence: 1, ts: 1_719_000_000_000, cashBalance: money("1000.000000"), realizedNetCashPnl: money("0.000000") },
      { basis: "cash-realized", sequence: 4, ts: 1_719_800_000_000, cashBalance: money("998.000000"), realizedNetCashPnl: money("-2.000000") },
      { basis: "cash-realized", sequence: 5, ts: 1_720_000_000_000, cashBalance: money("1015.000000"), realizedNetCashPnl: money("15.000000") },
      {
        basis: "current-equity",
        afterSequence: 5,
        ts: 1_720_000_000_000,
        equity: money("1020.000000"),
        evidenceObservedAt: 1_720_000_000_000,
        source: "paper-ledger"
      }
    ]
  },
  recentFills: {
    order: "newest-first",
    truncated: false,
    items: [{
      fillId: "fill-1",
      sequence: 3,
      ts: 1_719_700_000_000,
      symbol: "BTCUSDT",
      side: "buy",
      kind: "open",
      qty: 0.01,
      price: money("65000.000000"),
      fee: money("2.000000"),
      feeAsset: "USDT",
      realizedPnl: money("0.000000")
    }]
  },
  recentEvents: {
    order: "newest-first",
    truncated: false,
    items: [
      { eventId: "event-5", sequence: 5, ts: 1_720_000_000_000, type: "cash" },
      { eventId: "event-4", sequence: 4, ts: 1_719_800_000_000, type: "fee" },
      { eventId: "event-3", sequence: 3, ts: 1_719_700_000_000, type: "fill" },
      { eventId: "event-2", sequence: 2, ts: 1_719_500_000_000, type: "position" },
      { eventId: "event-1", sequence: 1, ts: 1_719_000_000_000, type: "account_initialized" }
    ]
  }
};

export const detailResponse: PaperPortfolioDetail = {
  portfolio,
  snapshot: projection,
  robots: [{ botId: "bot-1", botRevision: 3, name: "BTC trend", strategyName: "Trend", symbol: "BTCUSDT", status: "running", journal }]
};
