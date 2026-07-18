import type { Candle } from "@saltanatbotv2/contracts";
/**
 * `dataset-v1` — the versioned, runtime-neutral dataset contract for server
 * strategy evaluation (ADR 0003). Everything here is pure: no I/O, no wall
 * clock, no randomness. The SHA-256 used for fingerprints is implemented
 * locally so browser and Node runtimes produce byte-identical digests without
 * importing a runtime-specific crypto module.
 */
/** Deterministic engine identity stamped into every server evaluation result. */
export declare const BACKTEST_ENGINE_VERSION = "backtest-core-v1";
export declare const DATASET_SCHEMA_VERSION = "dataset-v1";
export declare const DATASET_TRAIN_FRACTION_MINIMUM = 0.5;
export declare const DATASET_TRAIN_FRACTION_MAXIMUM = 0.9;
export declare const DATASET_EMBARGO_BARS_MAXIMUM = 500;
/** Requested train/test split; the test share is always the remainder. */
export interface DatasetSplitConfigV1 {
    /** Leading share of each market's bars used for training (0.5..0.9). */
    trainFraction: number;
    /** Bars dropped between train end and test start (integer 0..500). */
    embargoBars: number;
}
export interface DatasetSplitV1 extends DatasetSplitConfigV1 {
    /** Remainder share reserved for out-of-sample testing (before the embargo gap). */
    testFraction: number;
}
export interface DatasetDescriptorV1 {
    schemaVersion: typeof DATASET_SCHEMA_VERSION;
    source: string;
    timeframe: string;
    /** Symbols sorted ascending; the same order the fingerprint serializes. */
    symbols: string[];
    fromMs: number;
    toMs: number;
    barCounts: Record<string, number>;
    split: DatasetSplitV1;
    fingerprint: string;
}
export type DatasetBarsBySymbol = ReadonlyMap<string, readonly Candle[]> | Readonly<Record<string, readonly Candle[]>>;
/** Contract violations fail closed with this typed error. */
export declare class DatasetContractError extends Error {
    constructor(message: string);
}
/**
 * Canonical serialization the fingerprint hashes:
 * `"dataset-v1\n<source>\n<timeframe>\n"` then, per symbol in sorted order,
 * `"<symbol>\n"` followed by one `"t,o,h,l,c,v\n"` line per bar using
 * canonical `String(Number(value))` formatting. Optional bar fields (`final`,
 * `source`) never enter the fingerprint.
 */
export declare function canonicalDatasetSerialization(source: string, timeframe: string, barsBySymbol: DatasetBarsBySymbol): string;
/** SHA-256 hex fingerprint over the canonical `dataset-v1` serialization. */
export declare function computeDatasetFingerprint(source: string, timeframe: string, barsBySymbol: DatasetBarsBySymbol): string;
export interface DatasetDescriptorInputV1 {
    source: string;
    timeframe: string;
    barsBySymbol: DatasetBarsBySymbol;
    split: DatasetSplitConfigV1;
}
/** Build the immutable descriptor (including fingerprint) for one evaluation dataset. */
export declare function buildDatasetDescriptor(input: DatasetDescriptorInputV1): DatasetDescriptorV1;
/**
 * Deterministic time-ordered train/test split with an embargo gap: the first
 * `floor(bars * trainFraction)` bars train, the next `embargoBars` bars are
 * dropped, and the remainder tests. Never random; the test window starts
 * strictly after the train window ends, so no lookahead is possible.
 */
export declare function splitDatasetBars<TBar extends {
    time: number;
}>(bars: readonly TBar[], split: DatasetSplitConfigV1): {
    train: TBar[];
    test: TBar[];
};
/** Validate and complete a split request (`testFraction` = remainder). */
export declare function normalizeDatasetSplit(split: DatasetSplitConfigV1): DatasetSplitV1;
/** SHA-256 of a string's UTF-8 bytes as lowercase hex, on any JS runtime. */
export declare function sha256Hex(text: string): string;
