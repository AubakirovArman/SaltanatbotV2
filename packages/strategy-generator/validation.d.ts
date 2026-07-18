import { type StrategyIR } from "@saltanatbotv2/strategy-core";
import { type CandidateValidation } from "./types.js";
/** Generator-specific fail-closed validation; this is narrower than the full StrategyIR schema. */
export declare function validateGeneratedStrategy(ir: StrategyIR): CandidateValidation;
