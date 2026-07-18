import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { StrategyBarTrace } from "@saltanatbotv2/strategy-core";
import type { BacktestDataProvenance } from "./provenance.js";
import type { BacktestExecutionTrace } from "./executionTrace.js";

/** Runtime-neutral backtest result and configuration contracts. */
export interface BacktestConfig {
  initialCapital: number;
  commissionPct: number;
  slippagePct: number;
  allowShort: boolean;
  /** `next_open` matches the live engine; `same_close` is the legacy mode. */
  fillTiming?: "next_open" | "same_close";
  maxLeverage?: number;
  qtyStep?: number;
  fundingRatePctPer8h?: number;
}

export const DEFAULT_BACKTEST_CONFIG: Required<BacktestConfig> = Object.freeze({
  initialCapital: 10_000,
  // Fee/slippage defaults are the shared paper fill model — one parity source.
  commissionPct: PAPER_FILL_MODEL_V1.feePct,
  slippagePct: PAPER_FILL_MODEL_V1.slipPct,
  allowShort: true,
  fillTiming: "next_open",
  maxLeverage: 5,
  qtyStep: 0,
  fundingRatePctPer8h: 0
});

export interface BacktestRunContext {
  symbol?: string;
  timeframe?: string;
  exchange?: string;
  marketType?: "spot" | "linear" | "inverse" | "unknown";
  priceType?: "trade" | "mark" | "index" | "unknown";
  requestedBars?: number;
  strategyHash?: string;
}

export interface BacktestDataGap {
  afterTime: number;
  beforeTime: number;
  missingBars: number;
}

export interface BacktestDataQuality {
  loadedBars: number;
  requestedBars?: number;
  partiallyLoaded: boolean;
  expectedIntervalMs?: number;
  missingBars: number;
  gaps: readonly BacktestDataGap[];
  gapsTruncated: boolean;
}

export interface BacktestReportMetadata {
  readonly schemaVersion: 1;
  readonly engine: "saltanat-backtest";
  readonly engineVersion: 1;
  readonly symbol: string;
  readonly timeframe: string;
  readonly exchange: string;
  readonly marketType: "spot" | "linear" | "inverse" | "unknown";
  readonly priceType: "trade" | "mark" | "index" | "unknown";
  readonly strategyHash: string;
  readonly provenanceFingerprint: string;
  readonly dataRange: Readonly<{ fromTime: number; toTime: number }>;
  readonly config: Readonly<Required<BacktestConfig>>;
  readonly assumptions: readonly string[];
  readonly dataQuality: Readonly<BacktestDataQuality>;
  /** Equal keys are required before performance runs may be compared. */
  readonly comparisonKey: string;
}

export interface Trade {
  direction: "long" | "short";
  entryIndex: number;
  exitIndex: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  reason: "signal" | "stop" | "target" | "close" | "liquidation";
  barsHeld: number;
  maePct: number;
  mfePct: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface TradeMarker {
  time: number;
  price: number;
  kind: "buy" | "sell" | "exit";
  label?: string;
}

export interface BacktestMetrics {
  netProfit: number;
  netProfitPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: number;
  avgTrade: number;
  expectancy: number;
  timeInMarketPct: number;
  finalEquity: number;
  avgMaePct: number;
  avgMfePct: number;
  fundingPaid: number;
  liquidated: boolean;
}

export interface TestedRange {
  fromTime: number;
  toTime: number;
  bars: number;
  warmupBars: number;
}

export interface BacktestResult {
  readonly schemaVersion: 1;
  name: string;
  trades: Trade[];
  equityCurve: EquityPoint[];
  markers: TradeMarker[];
  signals: TradeMarker[];
  alerts: { time: number; message: string }[];
  warnings: { time: number; message: string }[];
  metrics: BacktestMetrics;
  tested: TestedRange;
  varTrace?: { time: number; vars: Record<string, number> }[];
  /** Versioned evaluator intents for parity/debugging across runtime layers. */
  eventTrace: StrategyBarTrace[];
  /** Versioned broker/fill/position/equity trace for historical execution. */
  executionTrace: BacktestExecutionTrace;
  /** Complete primary/external candle-source summary for this run. */
  provenance: BacktestDataProvenance;
  /** Immutable, self-contained execution/data identity for export and comparison. */
  metadata: BacktestReportMetadata;
}

export interface BacktestComparison {
  comparable: boolean;
  differences: string[];
}

export interface BacktestResearchFile {
  schemaVersion: 1;
  kind: "saltanat-backtest-report";
  exportedAt: number;
  report: BacktestResult;
}
