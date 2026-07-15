import type { ContinuousMarketOnlyEvaluation } from "./continuousMarketEconomicsTypes.js";
import type { NLegOpportunity } from "./nLegTypes.js";
import { type MarketOpportunityEnvelope, type MarketOpportunityValidation } from "./opportunityEnvelopeTypes.js";
import type { BasisOpportunity, NativeSpreadOpportunity } from "./types.js";
export declare const NATIVE_SPREAD_OPPORTUNITY_MAX_AGE_MS = 10000;
export declare function normalizeBasisOpportunity(value: BasisOpportunity): MarketOpportunityEnvelope;
export declare function normalizeContinuousMarketOpportunity(value: ContinuousMarketOnlyEvaluation, context?: {
    now?: number;
    sourceCurrent?: boolean;
}): MarketOpportunityEnvelope;
export declare function normalizeNLegOpportunity(value: NLegOpportunity): MarketOpportunityEnvelope;
export declare function normalizeNativeSpreadOpportunity(value: NativeSpreadOpportunity, context?: {
    evaluatedAt?: number;
    now?: number;
}): MarketOpportunityEnvelope;
export declare function validateMarketOpportunityEnvelope(value: MarketOpportunityEnvelope): MarketOpportunityValidation;
export declare function assertMarketOpportunityEnvelope(value: MarketOpportunityEnvelope): MarketOpportunityEnvelope;
