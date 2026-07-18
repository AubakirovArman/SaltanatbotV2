import { createHash } from "node:crypto";
import {
  BACKTEST_ENGINE_VERSION,
  buildDatasetDescriptor,
  canonicalDatasetSerialization,
  computeDatasetFingerprint,
  DATASET_SCHEMA_VERSION,
  DatasetContractError,
  sha256Hex,
  splitDatasetBars
} from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";

const FIXTURE_FINGERPRINT = "7a61f6c6737cba8203ba700c527807728d5ba7b9ba5591b4212ab6f50d333dd8";

function fixtureBars() {
  return new Map([
    [
      "BTCUSDT",
      [
        { time: 1, open: 1.5, high: 2, low: 1, close: 1.75, volume: 10 },
        { time: 2, open: 1.75, high: 2.5, low: 1.5, close: 2, volume: 12 }
      ]
    ]
  ]);
}

function series(length: number) {
  return Array.from({ length }, (_, index) => ({ time: index + 1 }));
}

describe("dataset-v1 fingerprint", () => {
  it("implements SHA-256 identically to node:crypto across block sizes and UTF-8", () => {
    const cases = ["", "abc", "The quick brown fox jumps over the lazy dog", "a".repeat(55), "b".repeat(64), "c".repeat(1_000), "юникод-таңбалар-テスト".repeat(37)];
    for (const text of cases) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });

  it("produces the pinned golden fingerprint for the fixture dataset", () => {
    expect(computeDatasetFingerprint("binance", "1h", fixtureBars())).toBe(FIXTURE_FINGERPRINT);
    expect(computeDatasetFingerprint("binance", "1h", fixtureBars())).toBe(FIXTURE_FINGERPRINT);
  });

  it("changes the fingerprint when a single tick changes", () => {
    const changed = fixtureBars();
    changed.get("BTCUSDT")![1]!.close = 2.0001;
    expect(computeDatasetFingerprint("binance", "1h", changed)).not.toBe(FIXTURE_FINGERPRINT);
  });

  it("serializes canonically: String(Number) formatting, sorted symbols, Map/Record parity", () => {
    const record = {
      ETHUSDT: [{ time: 2, open: 2.5, high: 3, low: 2, close: 2.5, volume: 0 }],
      BTCUSDT: [{ time: 1, open: 1.1, high: 2, low: 1, close: 1.5, volume: 3 }]
    };
    const serialized = canonicalDatasetSerialization("binance", "1h", record);
    expect(serialized).toBe("dataset-v1\nbinance\n1h\nBTCUSDT\n1,1.1,2,1,1.5,3\nETHUSDT\n2,2.5,3,2,2.5,0\n");
    const map = new Map([
      ["ETHUSDT", record.ETHUSDT],
      ["BTCUSDT", record.BTCUSDT]
    ]);
    expect(computeDatasetFingerprint("binance", "1h", map)).toBe(computeDatasetFingerprint("binance", "1h", record));
  });

  it("fails closed on empty datasets, non-finite values and unordered bars", () => {
    expect(() => computeDatasetFingerprint("binance", "1h", new Map())).toThrow(DatasetContractError);
    expect(() => computeDatasetFingerprint("binance", "1h", { BTCUSDT: [] })).toThrow(DatasetContractError);
    expect(() =>
      computeDatasetFingerprint("binance", "1h", { BTCUSDT: [{ time: 1, open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 }] })
    ).toThrow(DatasetContractError);
    expect(() =>
      computeDatasetFingerprint("binance", "1h", {
        BTCUSDT: [
          { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
          { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 }
        ]
      })
    ).toThrow(DatasetContractError);
    expect(() => computeDatasetFingerprint("bi\nnance", "1h", fixtureBars())).toThrow(DatasetContractError);
  });
});

describe("dataset-v1 descriptor", () => {
  it("builds the versioned descriptor with sorted symbols, ranges, counts and split remainder", () => {
    const descriptor = buildDatasetDescriptor({
      source: "binance",
      timeframe: "1h",
      barsBySymbol: fixtureBars(),
      split: { trainFraction: 0.7, embargoBars: 8 }
    });
    expect(descriptor).toEqual({
      schemaVersion: DATASET_SCHEMA_VERSION,
      source: "binance",
      timeframe: "1h",
      symbols: ["BTCUSDT"],
      fromMs: 1,
      toMs: 2,
      barCounts: { BTCUSDT: 2 },
      split: { trainFraction: 0.7, embargoBars: 8, testFraction: 0.3 },
      fingerprint: FIXTURE_FINGERPRINT
    });
  });

  it("exports the deterministic engine identity for result stamping", () => {
    expect(BACKTEST_ENGINE_VERSION).toBe("backtest-core-v1");
    expect(DATASET_SCHEMA_VERSION).toBe("dataset-v1");
  });
});

describe("dataset-v1 split", () => {
  it("splits deterministically with an embargo gap and no lookahead", () => {
    const bars = series(100);
    const first = splitDatasetBars(bars, { trainFraction: 0.7, embargoBars: 8 });
    const second = splitDatasetBars(bars, { trainFraction: 0.7, embargoBars: 8 });
    expect(first.train).toHaveLength(70);
    expect(first.test).toHaveLength(22);
    expect(first.train.at(-1)!.time).toBe(70);
    // The embargo drops bars 71..78; the test window starts strictly afterwards.
    expect(first.test[0]!.time).toBe(79);
    expect(first.test[0]!.time).toBeGreaterThan(first.train.at(-1)!.time + 8);
    expect(second).toEqual(first);
  });

  it("keeps train counts stable when fraction * length lands a float ULP low", () => {
    // 0.58 * 50 === 28.999999999999996 in IEEE 754; the contract floors to 29.
    expect(splitDatasetBars(series(50), { trainFraction: 0.58, embargoBars: 0 }).train).toHaveLength(29);
  });

  it("enforces fraction and embargo bounds", () => {
    for (const trainFraction of [0.49, 0.91, Number.NaN]) {
      expect(() => splitDatasetBars(series(100), { trainFraction, embargoBars: 0 })).toThrow(DatasetContractError);
    }
    for (const embargoBars of [-1, 0.5, 501]) {
      expect(() => splitDatasetBars(series(100), { trainFraction: 0.7, embargoBars })).toThrow(DatasetContractError);
    }
    expect(() => splitDatasetBars(series(100), { trainFraction: 0.5, embargoBars: 0 })).not.toThrow();
    expect(() => splitDatasetBars(series(100), { trainFraction: 0.9, embargoBars: 500 })).toThrow(DatasetContractError);
  });

  it("rejects unordered bars and splits whose windows would be empty", () => {
    expect(() => splitDatasetBars([{ time: 2 }, { time: 1 }, { time: 3 }], { trainFraction: 0.7, embargoBars: 0 })).toThrow(
      /strictly increasing/
    );
    expect(() => splitDatasetBars([], { trainFraction: 0.7, embargoBars: 0 })).toThrow(/empty train window/);
    // The embargo consumes the whole remainder: fail closed, never lookahead.
    expect(() => splitDatasetBars(series(10), { trainFraction: 0.7, embargoBars: 3 })).toThrow(/empty test window/);
  });
});
