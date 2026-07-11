import type { Candle } from "@saltanatbotv2/contracts";
import type { SecurityDataContext, StrategyBarTrace } from "@saltanatbotv2/strategy-core";
import { type BacktestExecutionEvent } from "./executionTrace.js";
import type { VariableTracePoint } from "./reporting.js";
import type { BacktestConfig, BacktestComparison, BacktestDataGap, BacktestResearchFile, BacktestResult, BacktestRunContext, EquityPoint, Trade, TradeMarker } from "./types.js";
export interface BacktestReportAssembly {
    name: string;
    candles: Candle[];
    config: BacktestConfig;
    trades: Trade[];
    equityCurve: EquityPoint[];
    markers: TradeMarker[];
    signals: TradeMarker[];
    alerts: {
        time: number;
        message: string;
    }[];
    warnings: {
        time: number;
        message: string;
    }[];
    eventTrace: StrategyBarTrace[];
    executionEvents: BacktestExecutionEvent[];
    varTrace?: VariableTracePoint[];
    warmupBars: number;
    barsInMarket: number;
    liquidated: boolean;
    fundingPaid: number;
    securityData?: SecurityDataContext;
    context?: BacktestRunContext;
}
/** Assemble the canonical immutable report after the execution loop completes. */
export declare function assembleBacktestReport(input: BacktestReportAssembly): BacktestResult;
export declare function inspectBacktestDataQuality(candles: readonly Candle[], requestedBars?: number): Readonly<{
    missingBars: number;
    gaps: readonly BacktestDataGap[];
    gapsTruncated: boolean;
    expectedIntervalMs?: number;
    partiallyLoaded: boolean;
    requestedBars?: number;
    loadedBars: number;
}>;
export declare function compareBacktestReports(left: BacktestResult, right: BacktestResult): BacktestComparison;
export declare function createBacktestResearchFile(report: BacktestResult, exportedAt?: number): BacktestResearchFile;
export declare function serializeBacktestResearchFile(report: BacktestResult, exportedAt?: number): string;
export declare function createStrategyFingerprint(strategy: unknown): string;
