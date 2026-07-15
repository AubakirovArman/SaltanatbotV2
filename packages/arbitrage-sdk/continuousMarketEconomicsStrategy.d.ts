import type { ContinuousRouteCandidate } from "./continuousRoutes.js";
import type { ContinuousMarketBlockCode } from "./continuousMarketEconomicsTypes.js";
/** Exact strategy-evidence blockers that keep market-only observations non-actionable. */
export declare function expectedContinuousStrategyReasons(candidate: ContinuousRouteCandidate): Array<{
    code: ContinuousMarketBlockCode;
    subject: string;
}>;
