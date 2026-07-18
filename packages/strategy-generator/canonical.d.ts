import type { StrategyIR } from "@saltanatbotv2/strategy-core";
/** Canonical JSON retains statement order but normalizes object keys and input order. */
export declare function canonicalStrategyJson(ir: StrategyIR): string;
/** Two independent 32-bit FNV lanes plus payload length make a compact stable key. */
export declare function canonicalStrategyFingerprint(ir: StrategyIR): string;
export declare function stableStringify(value: unknown): string;
