import { describe, expect, it } from "vitest";
import { buildVolumeProfile } from "../src/chart/volumeProfile";

describe("visible-range volume profile", () => {
  it("conserves volume while splitting it by candle direction", () => {
    const profile = buildVolumeProfile([
      { time: 0, open: 0, high: 10, low: 0, close: 10, volume: 100 },
      { time: 1, open: 10, high: 10, low: 0, close: 0, volume: 60 }
    ], 4);
    expect(profile).toBeDefined();
    expect(profile?.totalVolume).toBeCloseTo(160, 8);
    expect(profile?.bins.reduce((sum, bin) => sum + bin.up, 0)).toBeCloseTo(100, 8);
    expect(profile?.bins.reduce((sum, bin) => sum + bin.down, 0)).toBeCloseTo(60, 8);
  });

  it("selects the point of control and expands a contiguous 70% value area", () => {
    const profile = buildVolumeProfile([
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 20 },
      { time: 1, open: 101, high: 101, low: 101, close: 101, volume: 80 },
      { time: 2, open: 102, high: 102, low: 102, close: 102, volume: 10 }
    ], 4);
    expect(profile).toBeDefined();
    expect(profile?.pocPrice).toBeGreaterThan(100.5);
    const valueArea = profile?.bins.filter((bin) => bin.valueArea) ?? [];
    expect(valueArea.length).toBeGreaterThan(0);
    expect(valueArea.reduce((sum, bin) => sum + bin.total, 0)).toBeGreaterThanOrEqual((profile?.totalVolume ?? 0) * 0.7);
    const indexes = valueArea.map((bin) => profile?.bins.indexOf(bin) ?? -1);
    expect(indexes.at(-1)! - indexes[0] + 1).toBe(indexes.length);
  });
});
