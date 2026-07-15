import type { Candle } from "@saltanatbotv2/contracts";
import type { StrategyIR } from "./index.js";
import { type SecurityDataContext, type UnresolvedSecuritySeries } from "./securityData.js";
export type UnresolvedSecurityPolicy = "error" | "chart";
/** Raised before a missing request.security() value can affect a decision. */
export declare class UnresolvedSecuritySeriesError extends Error {
    readonly symbol: string;
    readonly timeframe: string;
    readonly reason: UnresolvedSecuritySeries["reason"] | "missing-series";
    readonly code = "UNRESOLVED_SECURITY_SERIES";
    constructor(symbol: string, timeframe: string, reason?: UnresolvedSecuritySeries["reason"] | "missing-series");
}
/** Validate every dependency, including expressions in branches that never execute. */
export declare function assertSecurityDependenciesResolved(ir: StrategyIR, securityData: SecurityDataContext | undefined, policy: UnresolvedSecurityPolicy): void;
/** Resolve one series or enforce the selected fail-closed/preview-only policy. */
export declare function resolveSecurityCandles(securityData: SecurityDataContext | undefined, symbol: string, timeframe: string, policy: UnresolvedSecurityPolicy): Candle[] | undefined;
