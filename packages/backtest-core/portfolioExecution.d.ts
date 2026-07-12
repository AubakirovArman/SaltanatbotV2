import type { PortfolioTrade } from "./portfolioBacktest.js";
import type { Trade } from "./types.js";
export interface PortfolioExecutionAssumption {
    symbol: string;
    commissionPct: number;
    slippagePct: number;
}
export interface PortfolioExecutionTotals {
    trades: number;
    turnover: number;
    referenceGrossPnl: number;
    commissionPaid: number;
    estimatedSlippageCost: number;
    fundingPaid: number;
    totalCost: number;
    netPnl: number;
    allInCostBps: number;
    costDragPct: number | null;
}
export interface PortfolioExecutionMarket extends PortfolioExecutionTotals {
    symbol: string;
    commissionPct: number;
    slippagePct: number;
}
export interface PortfolioExecutionExitReason extends PortfolioExecutionTotals {
    reason: Trade["reason"];
}
export interface PortfolioExecutionAnalysis {
    method: "configured_fill_attribution";
    totals: PortfolioExecutionTotals;
    byMarket: PortfolioExecutionMarket[];
    byExitReason: PortfolioExecutionExitReason[];
}
/**
 * Attribute modeled portfolio results to configured commission, slippage and funding.
 * Slippage is reconstructed from recorded adverse fills; this is research TCA, not venue telemetry.
 */
export declare function analyzePortfolioExecution(trades: PortfolioTrade[], assumptions: ReadonlyArray<Readonly<PortfolioExecutionAssumption>>): PortfolioExecutionAnalysis;
