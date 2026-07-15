import type { ContinuousRouteCandidate } from "./continuousRoutes.js";
import { type ContinuousMarketEconomicsSummary, type ContinuousMarketEvaluation } from "./continuousMarketEconomicsTypes.js";
export type * from "./continuousMarketEconomicsTypes.js";
export interface ContinuousMarketEconomicsParseContext {
    capturedAt: number;
    totalCompatibleCandidates: number;
    discoveryTruncated: boolean;
    candidates: readonly ContinuousRouteCandidate[];
    instruments: unknown;
    topBooks: unknown;
    sources: unknown;
}
/** Strict parser for the additive, market-data-only economics siblings on continuous discovery. */
export declare function parseContinuousMarketEconomics(summaryValue: unknown, evaluationsValue: unknown, context: ContinuousMarketEconomicsParseContext): {
    marketEconomics: ContinuousMarketEconomicsSummary;
    marketEvaluations: ContinuousMarketEvaluation[];
};
