import { describe, expect, it } from "vitest";
import {
  parseChannelGeometryV1,
  parseChartAnchorV1,
  parseChartGeometryV1,
  parseHorizontalGeometryV1,
  parseTrendGeometryV1
} from "@saltanatbotv2/contracts";

const a = { time: 1_752_640_000_000, price: 60_000 };
const b = { time: 1_752_650_000_000, price: 61_000 };

describe("canonical chart geometry contract", () => {
  it("parses all geometry kinds through the discriminated entry point", () => {
    expect(parseChartGeometryV1({ kind: "horizontal", price: 60_000.25 })).toEqual({
      kind: "horizontal",
      price: 60_000.25
    });
    expect(parseChartGeometryV1({ kind: "trend", a, b })).toEqual({ kind: "trend", a, b });
    expect(parseChartGeometryV1({ kind: "channel", a, b, width: -250.5 })).toEqual({
      kind: "channel",
      a,
      b,
      width: -250.5
    });
    expect(parseHorizontalGeometryV1({ kind: "horizontal", price: -1 })).toEqual({
      kind: "horizontal",
      price: -1
    });
  });

  it("rejects malformed anchors, values and unknown fields", () => {
    expect(() => parseChartAnchorV1({ time: 0, price: 1 })).toThrow(/positive epoch-millisecond/);
    expect(() => parseChartAnchorV1({ time: -5, price: 1 })).toThrow(/positive epoch-millisecond/);
    expect(() => parseChartAnchorV1({ time: 1.5, price: 1 })).toThrow(/positive epoch-millisecond/);
    expect(() => parseChartAnchorV1({ time: 1, price: Number.NaN })).toThrow(/finite/);
    expect(() => parseChartAnchorV1({ time: 1, price: 1, extra: true })).toThrow(/missing or unknown/);
    expect(() => parseChartAnchorV1({ time: 1 })).toThrow(/missing or unknown/);
    expect(() => parseHorizontalGeometryV1({ kind: "horizontal", price: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => parseChannelGeometryV1({ kind: "channel", a, b, width: "5" })).toThrow(/finite/);
    expect(() => parseChartGeometryV1({ kind: "vertical", price: 1 })).toThrow(/unsupported/);
    expect(() => parseChartGeometryV1([])).toThrow(/must be an object/);
  });

  it("rejects degenerate trend and channel geometry", () => {
    expect(() => parseTrendGeometryV1({ kind: "trend", a, b: { ...b, time: a.time } })).toThrow(
      /share one time/
    );
    expect(() => parseChannelGeometryV1({ kind: "channel", a, b, width: 0 })).toThrow(/non-zero/);
    expect(() =>
      parseChannelGeometryV1({ kind: "channel", a, b: { ...b, time: a.time }, width: 5 })
    ).toThrow(/share one time/);
  });
});
