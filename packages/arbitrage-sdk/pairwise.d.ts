import type { PairwiseEvaluationRequest, PairwiseEvaluationResponse } from "./types.js";
/** Runtime preflight for the caller-supplied pairwise economic-identity contract. */
export declare function assertPairwiseRequestEconomicIdentity(value: unknown): asserts value is PairwiseEvaluationRequest;
/** Strict parser for the credential-free pairwise research evaluator response. */
export declare function parsePairwiseEvaluation(value: unknown): PairwiseEvaluationResponse;
