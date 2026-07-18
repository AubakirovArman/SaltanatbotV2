/**
 * `dataset-v1` — the versioned, runtime-neutral dataset contract for server
 * strategy evaluation (ADR 0003). Everything here is pure: no I/O, no wall
 * clock, no randomness. The SHA-256 used for fingerprints is implemented
 * locally so browser and Node runtimes produce byte-identical digests without
 * importing a runtime-specific crypto module.
 */
/** Deterministic engine identity stamped into every server evaluation result. */
export const BACKTEST_ENGINE_VERSION = "backtest-core-v1";
export const DATASET_SCHEMA_VERSION = "dataset-v1";
export const DATASET_TRAIN_FRACTION_MINIMUM = 0.5;
export const DATASET_TRAIN_FRACTION_MAXIMUM = 0.9;
export const DATASET_EMBARGO_BARS_MAXIMUM = 500;
/** Contract violations fail closed with this typed error. */
export class DatasetContractError extends Error {
    constructor(message) {
        super(message);
        this.name = "DatasetContractError";
    }
}
/**
 * Canonical serialization the fingerprint hashes:
 * `"dataset-v1\n<source>\n<timeframe>\n"` then, per symbol in sorted order,
 * `"<symbol>\n"` followed by one `"t,o,h,l,c,v\n"` line per bar using
 * canonical `String(Number(value))` formatting. Optional bar fields (`final`,
 * `source`) never enter the fingerprint.
 */
export function canonicalDatasetSerialization(source, timeframe, barsBySymbol) {
    const entries = normalizeDatasetEntries(source, timeframe, barsBySymbol);
    const parts = [`${DATASET_SCHEMA_VERSION}\n${source}\n${timeframe}\n`];
    for (const entry of entries) {
        parts.push(`${entry.symbol}\n`);
        for (const bar of entry.bars) {
            parts.push(`${canonicalNumber(bar.time)},${canonicalNumber(bar.open)},${canonicalNumber(bar.high)},${canonicalNumber(bar.low)},${canonicalNumber(bar.close)},${canonicalNumber(bar.volume)}\n`);
        }
    }
    return parts.join("");
}
/** SHA-256 hex fingerprint over the canonical `dataset-v1` serialization. */
export function computeDatasetFingerprint(source, timeframe, barsBySymbol) {
    return sha256Hex(canonicalDatasetSerialization(source, timeframe, barsBySymbol));
}
/** Build the immutable descriptor (including fingerprint) for one evaluation dataset. */
export function buildDatasetDescriptor(input) {
    const entries = normalizeDatasetEntries(input.source, input.timeframe, input.barsBySymbol);
    const split = normalizeDatasetSplit(input.split);
    const barCounts = {};
    let fromMs = Number.POSITIVE_INFINITY;
    let toMs = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
        barCounts[entry.symbol] = entry.bars.length;
        fromMs = Math.min(fromMs, entry.bars[0].time);
        toMs = Math.max(toMs, entry.bars[entry.bars.length - 1].time);
    }
    return {
        schemaVersion: DATASET_SCHEMA_VERSION,
        source: input.source,
        timeframe: input.timeframe,
        symbols: entries.map((entry) => entry.symbol),
        fromMs,
        toMs,
        barCounts,
        split,
        fingerprint: computeDatasetFingerprint(input.source, input.timeframe, input.barsBySymbol)
    };
}
/**
 * Deterministic time-ordered train/test split with an embargo gap: the first
 * `floor(bars * trainFraction)` bars train, the next `embargoBars` bars are
 * dropped, and the remainder tests. Never random; the test window starts
 * strictly after the train window ends, so no lookahead is possible.
 */
export function splitDatasetBars(bars, split) {
    const normalized = normalizeDatasetSplit(split);
    for (let index = 1; index < bars.length; index += 1) {
        if (bars[index].time <= bars[index - 1].time) {
            throw new DatasetContractError("Dataset bars must be strictly increasing in time before splitting.");
        }
    }
    // The epsilon keeps counts stable when fraction*length lands a float ULP
    // below an integer (e.g. 0.58 * 50); determinism is unaffected either way.
    const trainCount = Math.floor(bars.length * normalized.trainFraction + 1e-9);
    const train = bars.slice(0, trainCount);
    const test = bars.slice(trainCount + normalized.embargoBars);
    if (train.length === 0) {
        throw new DatasetContractError("Dataset split produced an empty train window.");
    }
    if (test.length === 0) {
        throw new DatasetContractError("Dataset split produced an empty test window after the embargo gap.");
    }
    return { train, test };
}
/** Validate and complete a split request (`testFraction` = remainder). */
export function normalizeDatasetSplit(split) {
    if (!Number.isFinite(split.trainFraction) ||
        split.trainFraction < DATASET_TRAIN_FRACTION_MINIMUM ||
        split.trainFraction > DATASET_TRAIN_FRACTION_MAXIMUM) {
        throw new DatasetContractError(`Dataset trainFraction must be between ${DATASET_TRAIN_FRACTION_MINIMUM} and ${DATASET_TRAIN_FRACTION_MAXIMUM}.`);
    }
    if (!Number.isInteger(split.embargoBars) || split.embargoBars < 0 || split.embargoBars > DATASET_EMBARGO_BARS_MAXIMUM) {
        throw new DatasetContractError(`Dataset embargoBars must be an integer between 0 and ${DATASET_EMBARGO_BARS_MAXIMUM}.`);
    }
    return {
        trainFraction: split.trainFraction,
        embargoBars: split.embargoBars,
        testFraction: Math.round((1 - split.trainFraction) * 1e6) / 1e6
    };
}
function normalizeDatasetEntries(source, timeframe, barsBySymbol) {
    requireLabel("source", source);
    requireLabel("timeframe", timeframe);
    const pairs = barsBySymbol instanceof Map ? [...barsBySymbol.entries()] : Object.entries(barsBySymbol);
    if (pairs.length === 0)
        throw new DatasetContractError("Dataset requires at least one symbol.");
    const entries = pairs
        .map(([symbol, bars]) => ({ symbol, bars }))
        .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    for (const entry of entries) {
        requireLabel("symbol", entry.symbol);
        if (entry.bars.length === 0)
            throw new DatasetContractError(`Dataset symbol ${entry.symbol} has no bars.`);
        for (let index = 0; index < entry.bars.length; index += 1) {
            const bar = entry.bars[index];
            if (!Number.isFinite(bar.time) ||
                !Number.isFinite(bar.open) ||
                !Number.isFinite(bar.high) ||
                !Number.isFinite(bar.low) ||
                !Number.isFinite(bar.close) ||
                !Number.isFinite(bar.volume)) {
                throw new DatasetContractError(`Dataset symbol ${entry.symbol} has a non-finite bar value at index ${index}.`);
            }
            if (index > 0 && bar.time <= entry.bars[index - 1].time) {
                throw new DatasetContractError(`Dataset symbol ${entry.symbol} bars must be strictly increasing in time.`);
            }
        }
    }
    return entries;
}
function requireLabel(name, value) {
    if (typeof value !== "string" || value.length === 0 || /[\n\r]/.test(value)) {
        throw new DatasetContractError(`Dataset ${name} must be a non-empty single-line string.`);
    }
}
function canonicalNumber(value) {
    return String(Number(value));
}
// --- Runtime-neutral SHA-256 (FIPS 180-4), verified against node:crypto in tests ---
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const SHA256_INITIAL_STATE = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
/** SHA-256 of a string's UTF-8 bytes as lowercase hex, on any JS runtime. */
export function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const bitLength = bytes.length * 8;
    const paddedLength = ((((bytes.length + 8) / 64) | 0) + 1) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength % 0x1_0000_0000, false);
    const state = Uint32Array.from(SHA256_INITIAL_STATE);
    const schedule = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i += 1)
            schedule[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i += 1) {
            const w15 = schedule[i - 15];
            const w2 = schedule[i - 2];
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
        }
        let a = state[0];
        let b = state[1];
        let c = state[2];
        let d = state[3];
        let e = state[4];
        let f = state[5];
        let g = state[6];
        let h = state[7];
        for (let i = 0; i < 64; i += 1) {
            const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + bigS1 + choose + SHA256_K[i] + schedule[i]) >>> 0;
            const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (bigS0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0;
        state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0;
        state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0;
        state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0;
        state[7] = (state[7] + h) >>> 0;
    }
    return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
function rotr(value, bits) {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
