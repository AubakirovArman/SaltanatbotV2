import { type GeneratorRuntimeOptions, type ResolvedGeneratorConfig, type StrategyGenerationResult, type StrategyGeneratorSpec } from "./types.js";
export declare class StrategyGenerationAbortedError extends Error {
    constructor();
}
/**
 * Generate bounded structural candidates only. Market data and candidate
 * evaluation deliberately remain outside this API.
 */
export declare function generateStrategyCandidates(spec?: StrategyGeneratorSpec, runtime?: GeneratorRuntimeOptions): Promise<StrategyGenerationResult>;
export declare function resolveGeneratorConfig(spec?: StrategyGeneratorSpec): ResolvedGeneratorConfig;
