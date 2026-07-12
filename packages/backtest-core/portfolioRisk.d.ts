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
    stress: PortfolioStressAnalysis;
}
export interface PortfolioRiskOptions {
    runs?: number;
    maxObservations?: number;
    blockSize?: number;
}
export type PortfolioStressScenarioId = "execution_cost" | "adverse_exit" | "funding_double" | "combined";
export interface PortfolioStressConfig {
    id: PortfolioStressScenarioId | "custom";
    /** Additional adverse basis points charged independently on entry and exit notional. */
    extraFillCostBps: number;
    /** Additional adverse basis points charged once on exit notional. */
    adverseExitBps: number;
    /** Adverse multiplier applied to observed funding; values below one clamp to one. */
    fundingMultiplier: number;
}
export interface PortfolioStressScenario extends PortfolioStressConfig {
    extraCost: number;
    netProfit: number;
    netProfitPct: number;
    finalEquity: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    deltaFromBaseline: number;
    profitable: boolean;
}
export interface PortfolioStressAnalysis {
    baselineNetProfit: number;
    turnover: number;
    breakEvenExtraFillCostBps: number | null;
    scenarios: PortfolioStressScenario[];
}
export declare const DEFAULT_PORTFOLIO_STRESS_SCENARIOS: ReadonlyArray<Readonly<PortfolioStressConfig>>;
/** Analyze one shared-equity portfolio without relying on browser or transport state. */
export declare function analyzePortfolioRisk(equityCurve: PortfolioEquityPoint[], trades: PortfolioTrade[], initialCapital: number, options?: PortfolioRiskOptions): PortfolioRiskAnalysis;
export declare function stressPortfolio(equityCurve: PortfolioEquityPoint[], trades: PortfolioTrade[], initialCapital: number, scenarios?: ReadonlyArray<Readonly<PortfolioStressConfig>>): PortfolioStressAnalysis;
export declare function blockBootstrapRisk(sourceReturns: number[], initialCapital: number, options?: PortfolioRiskOptions): PortfolioMonteCarloRisk | null;
