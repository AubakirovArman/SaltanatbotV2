import type { PortfolioEquityPoint, PortfolioTrade } from "./portfolioBacktest.js";
export interface RiskPercentiles {
    p5: number;
    p50: number;
    p95: number;
}
export interface PortfolioHistoricalRisk {
    observations: number;
    lossProbabilityPct: number;
    valueAtRisk95Pct: number;
    expectedShortfall95Pct: number;
    valueAtRisk99Pct: number;
    expectedShortfall99Pct: number;
    worstPeriodPct: number;
    ulcerIndex: number;
    longestRecoveryPeriods: number;
}
export interface PortfolioConcentrationRisk {
    largestSymbol: string | null;
    largestAllocationPct: number;
    effectiveSymbols: number;
    herfindahlIndex: number;
    allocations: Array<{
        symbol: string;
        allocatedNotional: number;
        sharePct: number;
    }>;
}
export interface PortfolioMonteCarloRisk {
    method: "moving_block_bootstrap";
    runs: number;
    observations: number;
    sourceObservations: number;
    blockSize: number;
    netProfit: RiskPercentiles;
    maxDrawdownPct: RiskPercentiles;
    probabilityOfLossPct: number;
    riskOfHalfPct: number;
    riskOfRuinPct: number;
}
export interface PortfolioRiskAnalysis {
    historical: PortfolioHistoricalRisk;
    concentration: PortfolioConcentrationRisk;
    monteCarlo: PortfolioMonteCarloRisk | null;
}
export interface PortfolioRiskOptions {
    runs?: number;
    maxObservations?: number;
    blockSize?: number;
}
/** Analyze one shared-equity portfolio without relying on browser or transport state. */
export declare function analyzePortfolioRisk(equityCurve: PortfolioEquityPoint[], trades: PortfolioTrade[], initialCapital: number, options?: PortfolioRiskOptions): PortfolioRiskAnalysis;
export declare function blockBootstrapRisk(sourceReturns: number[], initialCapital: number, options?: PortfolioRiskOptions): PortfolioMonteCarloRisk | null;
