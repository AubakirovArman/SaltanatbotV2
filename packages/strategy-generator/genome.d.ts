import type { GeneratorRandom } from "./random.js";
import { type MutationRecord, type SignalGenome, type StrategyFamily, type StrategyGenome, type TradeDirection } from "./types.js";
export interface MutationOptions {
    rate: number;
    families?: readonly StrategyFamily[];
    directions?: readonly TradeDirection[];
    ensureMutation?: boolean;
}
export declare function randomStrategyGenome(random: GeneratorRandom, families?: readonly StrategyFamily[], directions?: readonly TradeDirection[]): StrategyGenome;
export declare function randomSignal(random: GeneratorRandom, families?: readonly StrategyFamily[]): SignalGenome;
export declare function crossoverStrategyGenomes(left: StrategyGenome, right: StrategyGenome, random: GeneratorRandom): StrategyGenome;
export declare function mutateStrategyGenome(genome: StrategyGenome, random: GeneratorRandom, options: MutationOptions): {
    genome: StrategyGenome;
    mutationLog: MutationRecord[];
};
