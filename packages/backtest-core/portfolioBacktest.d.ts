import type { Candle } from "@saltanatbotv2/contracts";
import { type PortfolioRiskAnalysis } from "./portfolioRisk.js";
import type { BacktestResult, EquityPoint, Trade } from "./types.js";
export interface PortfolioBacktestConfig {
    initialCapital: number;
    maxConcurrentPositions: number;
    maxGrossExposurePct: number;
    maxPositionExposurePct: number;
    /** Reject a partial allocation smaller than this percentage of its target. */
    minAllocationPct: number;
}
export declare const DEFAULT_PORTFOLIO_BACKTEST_CONFIG: Readonly<PortfolioBacktestConfig>;
export interface PortfolioBacktestLeg {
    symbol: string;
    candles: Candle[];
    report: BacktestResult;
}
export interface PortfolioTrade extends Trade {
    symbol: string;
    requestedNotional: number;
    allocatedNotional: number;
    allocationPct: number;
    scale: number;
    fundingPaid: number;
}
export type PortfolioRejectionReason = "max_concurrent" | "gross_exposure" | "allocation_too_small" | "invalid_candidate";
export interface PortfolioRejectedEntry {
    symbol: string;
    time: number;
    reason: PortfolioRejectionReason;
    requestedNotional: number;
    availableNotional: number;
}
export interface PortfolioEquityPoint extends EquityPoint {
    grossExposure: number;
    grossExposurePct: number;
    openPositions: number;
}
export interface PortfolioSymbolContribution {
    symbol: string;
    candidateTrades: number;
    acceptedTrades: number;
    rejectedTrades: number;
    wins: number;
    netProfit: number;
    fundingPaid: number;
    contributionPct: number;
}
export interface PortfolioCorrelationMatrix {
    symbols: string[];
    values: Array<Array<number | null>>;
    averagePairwise: number | null;
}
export interface PortfolioBacktestMetrics {
    netProfit: number;
    netProfitPct: number;
    finalEquity: number;
    totalCandidates: number;
    acceptedTrades: number;
    rejectedTrades: number;
    excludedCandidates: number;
    wins: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpe: number;
    timeInMarketPct: number;
    peakGrossExposurePct: number;
    maxConcurrentPositions: number;
    fundingPaid: number;
}
export interface PortfolioBacktestResult {
    readonly schemaVersion: 1;
    readonly kind: "saltanat-portfolio-backtest";
    name: string;
    config: Readonly<PortfolioBacktestConfig>;
    symbols: string[];
    commonRange: Readonly<{
        fromTime: number;
        toTime: number;
        points: number;
    }>;
    equityCurve: PortfolioEquityPoint[];
    trades: PortfolioTrade[];
    rejectedEntries: PortfolioRejectedEntry[];
    contributions: PortfolioSymbolContribution[];
    correlation: PortfolioCorrelationMatrix;
    metrics: PortfolioBacktestMetrics;
    risk: PortfolioRiskAnalysis;
    assumptions: string[];
}
/**
 * Replay independently generated candidate fills through one chronological capital allocator.
 * Signal/fill prices remain those of each canonical single-market report; quantity is re-scaled
 * against shared mark-to-market equity and portfolio exposure limits.
 */
export declare function simulatePortfolioBacktest(legs: PortfolioBacktestLeg[], config?: Partial<PortfolioBacktestConfig>): PortfolioBacktestResult;
export declare function sanitizePortfolioBacktestConfig(input: Partial<PortfolioBacktestConfig>): PortfolioBacktestConfig;
