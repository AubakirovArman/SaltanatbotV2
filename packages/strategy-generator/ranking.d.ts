import type { CandidateEvaluationSet, MultiMarketRankingPolicy, RankedCandidateEvaluation } from "./types.js";
export declare const DEFAULT_MULTI_MARKET_RANKING_POLICY: Readonly<MultiMarketRankingPolicy>;
/** Rank caller-supplied train/OOS metrics without loading data or running tests. */
export declare function rankMultiMarketEvaluations(evaluations: readonly CandidateEvaluationSet[], overrides?: Partial<MultiMarketRankingPolicy>): RankedCandidateEvaluation[];
export declare function resolveRankingPolicy(overrides?: Partial<MultiMarketRankingPolicy>): MultiMarketRankingPolicy;
