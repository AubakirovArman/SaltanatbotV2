import type { GeneratorMaKind, StrategyFamily, TradeDirection } from "./types.js";
export type GeneratorRandom = () => number;
/** Mulberry32 keeps runs independent of clock and global Math.random state. */
export declare function createGeneratorRandom(seed: number): GeneratorRandom;
export declare function pick<T>(values: readonly T[], random: GeneratorRandom): T;
export declare function randomInt(random: GeneratorRandom, min: number, max: number, step?: number): number;
export declare function randomDecimal(random: GeneratorRandom, min: number, max: number, step: number): number;
export declare function canonicalNumber(value: number): number;
export declare const ALL_FAMILIES: readonly StrategyFamily[];
export declare const ALL_DIRECTIONS: readonly TradeDirection[];
export declare const ALL_MA_KINDS: readonly GeneratorMaKind[];
export declare function clamp(value: number, min: number, max: number): number;
export declare function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number;
export declare function finiteOr(value: number | undefined, fallback: number): number;
