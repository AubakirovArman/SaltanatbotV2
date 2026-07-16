import { describe, expect, it } from "vitest";
import { MEBIBYTE, rawJsHeapOlsSlopeMiBPerMinute, summarizeRetainedHeapCheckpoints, type TimedHeapReading } from "../../e2e/support/soakStatistics";

const checkpoint = (atMs: number, mib: number): TimedHeapReading[] => [
  { atMs, usedHeapBytes: (mib - 0.05) * MEBIBYTE },
  { atMs: atMs + 10, usedHeapBytes: mib * MEBIBYTE },
  { atMs: atMs + 20, usedHeapBytes: (mib + 0.05) * MEBIBYTE }
];

describe("soak retained-heap statistics", () => {
  it("does not mistake a raw V8 sawtooth for retained growth", () => {
    const rawMiB = [20, 22, 24, 26, 20, 22, 24, 26, 20, 22, 24, 26, 28];
    const raw = rawMiB.map((mib, index) => ({ atMs: index * 15_000, usedHeapBytes: mib * MEBIBYTE }));
    const retained = summarizeRetainedHeapCheckpoints(checkpoint(0, 20), checkpoint(180_000, 20), 180_000);

    expect(rawJsHeapOlsSlopeMiBPerMinute(raw)).toBeGreaterThan(1);
    expect(retained.stable).toBe(true);
    expect(retained.upperGrowthRateMiBPerMinute).toBeLessThan(1);
  });

  it("detects retained growth even when the raw OLS trend falls", () => {
    const rawMiB = [20, 40, 38, 36, 34, 32, 30, 28, 26, 24.5, 26, 25, 25];
    const raw = rawMiB.map((mib, index) => ({ atMs: index * 15_000, usedHeapBytes: mib * MEBIBYTE }));
    const retained = summarizeRetainedHeapCheckpoints(checkpoint(0, 20), checkpoint(180_000, 24.5), 180_000);

    expect(rawJsHeapOlsSlopeMiBPerMinute(raw)).toBeLessThan(0);
    expect(retained.stable).toBe(true);
    expect(retained.netGrowthRateMiBPerMinute).toBeCloseTo(1.5, 6);
    expect(retained.upperGrowthRateMiBPerMinute).toBeGreaterThan(1);
  });

  it("keeps the one MiB per minute boundary explicit", () => {
    const atBoundary = summarizeRetainedHeapCheckpoints(checkpoint(0, 20), checkpoint(180_000, 22.9), 180_000);
    const aboveBoundary = summarizeRetainedHeapCheckpoints(checkpoint(0, 20), checkpoint(180_000, 23.01), 180_000);

    expect(atBoundary.upperGrowthRateMiBPerMinute).toBeLessThanOrEqual(1);
    expect(aboveBoundary.upperGrowthRateMiBPerMinute).toBeGreaterThan(1);
  });

  it("fails closed for unstable checkpoints and invalid durations", () => {
    const unstable = checkpoint(0, 20);
    unstable[2] = { atMs: 20, usedHeapBytes: 24 * MEBIBYTE };

    expect(summarizeRetainedHeapCheckpoints(unstable, checkpoint(180_000, 20), 180_000).stable).toBe(false);
    expect(() => summarizeRetainedHeapCheckpoints(checkpoint(0, 20), checkpoint(0, 20), 0)).toThrow(/positive finite/);
  });
});
