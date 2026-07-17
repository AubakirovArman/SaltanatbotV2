import type { PaperLedgerEvent } from "./paperLedger.js";
import type { MarketType, OrderType, PositionSide, Side, Tif } from "./types.js";

export const PAPER_PORTFOLIO_SCHEMA_VERSION = "paper-portfolio-v1" as const;
export const PAPER_METRICS_FORMULA_VERSION = "paper-metrics-v1" as const;
export const PAPER_ROBOT_JOURNAL_SCHEMA_VERSION = "paper-robot-journal-v1" as const;
export const PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION = "paper-realized-cash-curve-v1" as const;

export type PaperPortfolioSchemaVersion = typeof PAPER_PORTFOLIO_SCHEMA_VERSION;
export type PaperMetricsFormulaVersion = typeof PAPER_METRICS_FORMULA_VERSION;
export type PaperRobotJournalSchemaVersion = typeof PAPER_ROBOT_JOURNAL_SCHEMA_VERSION;
export type PaperRealizedCashCurveFormulaVersion = typeof PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION;
/** Canonical signed quote-currency amount with exactly six fractional digits. */
export type PaperMoney = string;

/** A JSON-safe value whose evidence quality is never hidden behind a numeric zero. */
export type EvidenceValue<T> =
  | { status: "available"; value: T; observedAt: number; source: string }
  | { status: "stale"; lastValue: T; observedAt: number; source: string; staleByMs: number; reason: string }
  | { status: "unavailable"; reason: string };

export type PaperRobotRuntimeState = "idle" | "orders_open" | "position_open" | "position_and_orders_open";
export type PaperAllocationStatus = "active" | "released" | "closed";

export interface PaperDurableMarkInput {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  symbol: string;
  price: PaperMoney;
  observedAt: number;
  /** Durable source-specific expiry. The projector also enforces its global
   * freshness ceiling and uses whichever boundary expires first. */
  expiresAt: number;
  persistedAt: number;
  source: string;
  durable: true;
}

export interface PaperRobotProjectionInput {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  market: MarketType;
  allocationStatus: PaperAllocationStatus;
  allocation: PaperMoney;
  ledgerEvents: readonly PaperLedgerEvent[];
  currentMarks: readonly PaperDurableMarkInput[];
}

export interface PaperPortfolioProjectionInput {
  schemaVersion: PaperPortfolioSchemaVersion;
  formulaVersion: PaperMetricsFormulaVersion;
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  epochStartedAt: number;
  asOf: number;
  markFreshnessMs: number;
  initialCapital: PaperMoney;
  unallocatedCash: PaperMoney;
  robots: readonly PaperRobotProjectionInput[];
}

export interface PaperRobotProjectionContext {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  epochStartedAt: number;
  asOf: number;
  markFreshnessMs: number;
}

export interface PaperTradeStatistics {
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  grossProfit: PaperMoney;
  grossLoss: PaperMoney;
  winRate: EvidenceValue<number>;
  profitFactor: EvidenceValue<number>;
  expectancy: EvidenceValue<PaperMoney>;
}

export interface PaperPositionProjection {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  symbol: string;
  side: PositionSide;
  qty: number;
  entryPrice: PaperMoney;
  leverage: number;
  openedAt: number;
  markPrice: EvidenceValue<PaperMoney>;
  unrealizedPnl: EvidenceValue<PaperMoney>;
  grossExposure: EvidenceValue<PaperMoney>;
  netExposure: EvidenceValue<PaperMoney>;
  committedCapital: EvidenceValue<PaperMoney>;
  positionMargin: EvidenceValue<PaperMoney>;
}

export interface PaperOpenOrderProjection {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  reduceOnly: boolean;
  tif: Tif;
  createdAt: number;
  referencePrice: EvidenceValue<PaperMoney>;
  committedCapital: EvidenceValue<PaperMoney>;
  clientId?: string;
  price?: PaperMoney;
  triggerPrice?: PaperMoney;
}

export interface PaperCashConservation {
  expectedCashBalance: PaperMoney;
  actualCashBalance: PaperMoney;
  difference: PaperMoney;
  balanced: true;
}

export interface PaperRobotMetrics {
  cashBalance: PaperMoney;
  feesPaid: PaperMoney;
  fundingNet: PaperMoney;
  realizedNetCashPnl: PaperMoney;
  legacyCashAdjustments: PaperMoney;
  cashEventMaxDrawdown: PaperMoney;
  unrealizedPnl: EvidenceValue<PaperMoney>;
  grossExposure: EvidenceValue<PaperMoney>;
  netExposure: EvidenceValue<PaperMoney>;
  equity: EvidenceValue<PaperMoney>;
  reservedCapital: PaperMoney;
  committedCapital: EvidenceValue<PaperMoney>;
  margin: EvidenceValue<PaperMoney>;
  borrowing: EvidenceValue<PaperMoney>;
  tradeStatistics: PaperTradeStatistics;
}

export interface PaperRobotProjection {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  market: MarketType;
  allocationStatus: PaperAllocationStatus;
  allocation: PaperMoney;
  runtimeState: PaperRobotRuntimeState;
  ledger: { eventCount: number; lastSequence: number; observedAt: number };
  metrics: PaperRobotMetrics;
  positions: PaperPositionProjection[];
  openOrders: PaperOpenOrderProjection[];
  cashConservation: PaperCashConservation;
}

export interface PaperPortfolioAggregates {
  allocatedCapital: PaperMoney;
  unallocatedCash: PaperMoney;
  initialCapital: PaperMoney;
  cashBalance: PaperMoney;
  feesPaid: PaperMoney;
  fundingNet: PaperMoney;
  realizedNetCashPnl: PaperMoney;
  legacyCashAdjustments: PaperMoney;
  cashEventMaxDrawdown: PaperMoney;
  unrealizedPnl: EvidenceValue<PaperMoney>;
  grossExposure: EvidenceValue<PaperMoney>;
  netExposure: EvidenceValue<PaperMoney>;
  equity: EvidenceValue<PaperMoney>;
  reservedCapital: PaperMoney;
  availableCapital: PaperMoney;
  committedCapital: EvidenceValue<PaperMoney>;
  margin: EvidenceValue<PaperMoney>;
  borrowing: EvidenceValue<PaperMoney>;
  tradeStatistics: PaperTradeStatistics;
}

export interface PaperPortfolioProjection {
  schemaVersion: PaperPortfolioSchemaVersion;
  formulaVersion: PaperMetricsFormulaVersion;
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  epochStartedAt: number;
  asOf: number;
  robots: PaperRobotProjection[];
  positions: PaperPositionProjection[];
  openOrders: PaperOpenOrderProjection[];
  aggregates: PaperPortfolioAggregates;
  cashConservation: PaperCashConservation;
}

/**
 * A historical point backed only by a persisted current-epoch cash event.
 * It intentionally makes no claim about historical mark-to-market equity.
 */
export interface PaperRealizedCashCurvePoint {
  basis: "cash-realized";
  sequence: number;
  ts: number;
  cashBalance: PaperMoney;
  realizedNetCashPnl: PaperMoney;
}

/** One present-time equity observation, included only with available evidence. */
export interface PaperCurrentEquityCurvePoint {
  basis: "current-equity";
  afterSequence: number;
  ts: number;
  equity: PaperMoney;
  evidenceObservedAt: number;
  source: string;
}

export type PaperRobotCurvePoint = PaperRealizedCashCurvePoint | PaperCurrentEquityCurvePoint;

export interface PaperRobotRealizedCashCurve {
  formulaVersion: PaperRealizedCashCurveFormulaVersion;
  basis: "current-epoch-realized-cash";
  pointOrder: "oldest-first";
  truncated: boolean;
  sourceCashPointCount: number;
  points: PaperRobotCurvePoint[];
}

export interface PaperRecentFillSummary {
  fillId: string;
  sequence: number;
  ts: number;
  symbol: string;
  side: Side;
  kind: "open" | "close";
  qty: number;
  price: PaperMoney;
  fee: PaperMoney;
  feeAsset?: string;
  realizedPnl: PaperMoney;
}

/** Safe append-only metadata. Event data and idempotency/command fields are omitted. */
export interface PaperRecentLedgerEventMetadata {
  eventId: string;
  sequence: number;
  ts: number;
  type: PaperLedgerEvent["type"];
}

export interface PaperRecentFillWindow {
  order: "newest-first";
  truncated: boolean;
  items: PaperRecentFillSummary[];
}

export interface PaperRecentLedgerEventWindow {
  order: "newest-first";
  truncated: boolean;
  items: PaperRecentLedgerEventMetadata[];
}

/** Owner-scoped, restart-deterministic evidence for one exact bot revision. */
export interface PaperRobotJournal {
  schemaVersion: PaperRobotJournalSchemaVersion;
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  curve: PaperRobotRealizedCashCurve;
  recentFills: PaperRecentFillWindow;
  recentEvents: PaperRecentLedgerEventWindow;
}
