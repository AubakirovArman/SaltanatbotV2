import type { DcaParamsV1, GridParamsV1 } from "@saltanatbotv2/contracts";

export const PAPER_PORTFOLIO_SCHEMA_VERSION = "paper-portfolio-v1" as const;
export const PAPER_PORTFOLIO_LIST_SCHEMA_VERSION = "paper-portfolio-list-v1" as const;
export const PAPER_METRICS_FORMULA_VERSION = "paper-metrics-v1" as const;
export const PAPER_ROBOT_JOURNAL_SCHEMA_VERSION = "paper-robot-journal-v1" as const;
export const PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION = "paper-realized-cash-curve-v1" as const;

export type PaperMoney = string;
export type PaperPortfolioStatus = "active" | "archived";
export type PaperAllocationStatus = "active" | "released" | "closed";
export type PaperRobotRuntimeState = "idle" | "orders_open" | "position_open" | "position_and_orders_open";
export type PaperRobotControlStatus = "idle" | "stopped" | "running" | "paused" | "error";
export type PaperRobotAction = "start" | "pause" | "resume" | "stop";
export type PaperLedgerEventType =
  | "account_initialized"
  | "order_upserted"
  | "order_cancelled"
  | "fill"
  | "fee"
  | "cash"
  | "position"
  | "funding"
  | "settings"
  | "command_completed";

export type EvidenceValue<T> =
  | { status: "available"; value: T; observedAt: number; source: string }
  | { status: "stale"; lastValue: T; observedAt: number; source: string; staleByMs: number; reason: string }
  | { status: "unavailable"; reason: string };

export interface PaperPortfolioMetadata {
  ownerUserId: string;
  id: string;
  name: string;
  status: PaperPortfolioStatus;
  currency: "USDT";
  revision: number;
  currentEpoch: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
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
  side: "long" | "short";
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
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market" | "stop_limit" | "tp_market" | "tp_limit";
  qty: number;
  reduceOnly: boolean;
  tif: "GTC" | "IOC" | "FOK";
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
  market: "spot" | "futures";
  allocation: PaperMoney;
  allocationStatus: PaperAllocationStatus;
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
  schemaVersion: typeof PAPER_PORTFOLIO_SCHEMA_VERSION;
  formulaVersion: typeof PAPER_METRICS_FORMULA_VERSION;
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

export interface PaperRealizedCashCurvePoint {
  basis: "cash-realized";
  sequence: number;
  ts: number;
  cashBalance: PaperMoney;
  realizedNetCashPnl: PaperMoney;
}

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
  formulaVersion: typeof PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION;
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
  side: "buy" | "sell";
  kind: "open" | "close";
  qty: number;
  price: PaperMoney;
  fee: PaperMoney;
  feeAsset?: string;
  realizedPnl: PaperMoney;
}

export interface PaperRecentLedgerEventMetadata {
  eventId: string;
  sequence: number;
  ts: number;
  type: PaperLedgerEventType;
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

export interface PaperRobotJournal {
  schemaVersion: typeof PAPER_ROBOT_JOURNAL_SCHEMA_VERSION;
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  curve: PaperRobotRealizedCashCurve;
  recentFills: PaperRecentFillWindow;
  recentEvents: PaperRecentLedgerEventWindow;
}

/**
 * Additive DCA cycle info for kind === "dca" robots. Every field is optional and
 * parsed leniently: malformed values are dropped, never fatal, so older and newer
 * server payloads both render.
 */
export interface PaperRobotDcaRuntime {
  cycleState?: string;
  safetyOrdersFilled?: number;
  safetyOrdersTotal?: number;
  averageEntryPrice?: number;
  nextSafetyOrderPrice?: number;
  takeProfitPrice?: number;
  cooldownUntil?: number;
  params?: DcaParamsV1;
}

/**
 * Additive grid state info for kind === "grid" robots. Every field is optional
 * and parsed leniently: malformed values are dropped, never fatal, so older and
 * newer server payloads both render. These field names are the canonical
 * browser shape the server read-model mirrors exactly.
 */
export interface PaperRobotGridRuntime {
  phase?: string;
  mode?: string;
  spacing?: string;
  lowerBound?: number;
  upperBound?: number;
  levelsTotal?: number;
  levelsResting?: number;
  levelsFilled?: number;
  levelsCooldown?: number;
  inventoryBaseQty?: number;
  inventoryAvgCost?: number;
  realizedGridPnl?: number;
  cyclesCompleted?: number;
  stopReason?: string;
  params?: GridParamsV1;
}

export interface PaperRobotRuntimeMetadata {
  botId: string;
  botRevision?: number;
  name?: string;
  strategyName?: string;
  symbol?: string;
  status?: PaperRobotControlStatus;
  lastError?: string;
  dca?: PaperRobotDcaRuntime;
  grid?: PaperRobotGridRuntime;
  journal: PaperRobotJournal;
}

export interface PaperPortfolioListResponse {
  schemaVersion: typeof PAPER_PORTFOLIO_LIST_SCHEMA_VERSION;
  asOf: number;
  portfolios: PaperPortfolioMetadata[];
}

export interface PaperPortfolioDetail {
  portfolio: PaperPortfolioMetadata;
  snapshot: PaperPortfolioProjection;
  robots: PaperRobotRuntimeMetadata[];
  lastError?: string;
}

export interface PaperPortfolioMutationResult extends PaperPortfolioDetail {
  replayed?: boolean;
}
