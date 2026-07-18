import { type StrategyIR } from "@saltanatbotv2/strategy-core";
import type { StrategyGenome } from "./types.js";
/** Compile only the closed, bounded grammar represented by StrategyGenome. */
export declare function compileStrategyGenome(genome: StrategyGenome): StrategyIR;
