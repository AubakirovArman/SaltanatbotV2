import { describe, expect, it } from "vitest";
import { channelGeometryOf, channelWidth, lineValueAt } from "../src/chart/geometry";

const a = { time: 1_752_640_000_000, price: 100 };
const b = { time: 1_752_640_600_000, price: 110 };

describe("canonical chart geometry helpers", () => {
  it("evaluates the infinite base line at any time, including extrapolation", () => {
    expect(lineValueAt(a, b, a.time)).toBe(100);
    expect(lineValueAt(a, b, b.time)).toBe(110);
    expect(lineValueAt(a, b, (a.time + b.time) / 2)).toBe(105);
    expect(lineValueAt(a, b, b.time + 600_000)).toBe(120);
    expect(lineValueAt(a, b, a.time - 600_000)).toBe(90);
    expect(lineValueAt(a, { ...b, time: a.time }, 123)).toBe(a.price);
  });

  it("measures the signed width at the anchor's own time and NaN on vertical bases", () => {
    expect(channelWidth(a, b, { time: (a.time + b.time) / 2, price: 103 })).toBe(-2);
    expect(channelWidth(a, b, { time: a.time, price: 104.5 })).toBe(4.5);
    expect(channelWidth(a, b, { time: b.time + 600_000, price: 120 })).toBe(0);
    expect(channelWidth(a, { ...b, time: a.time }, { time: a.time, price: 1 })).toBeNaN();
  });

  it("derives canonical channel geometry exactly like the server-side validator", () => {
    const geometry = channelGeometryOf([a, b, { time: a.time + 300_000, price: 102.5 }]);
    expect(geometry).toEqual({ kind: "channel", a, b, width: -2.5 });

    const fractional = channelGeometryOf([
      { ...a, time: a.time + 0.4 },
      b,
      { time: a.time + 300_000, price: 102.5 }
    ]);
    expect(fractional?.a.time).toBe(a.time);
    expect(Number.isSafeInteger(fractional?.a.time)).toBe(true);
  });

  it("returns undefined whenever the shared contract rejects the anchors", () => {
    expect(channelGeometryOf([a, b])).toBeUndefined();
    expect(channelGeometryOf([a, b, { time: a.time + 300_000, price: 105 }])).toBeUndefined();
    expect(channelGeometryOf([a, { ...b, time: a.time }, { time: a.time, price: 90 }])).toBeUndefined();
    expect(channelGeometryOf([{ time: -5, price: 100 }, b, { time: a.time, price: 90 }])).toBeUndefined();
    expect(channelGeometryOf([{ time: a.time, price: Number.NaN }, b, { time: a.time, price: 90 }])).toBeUndefined();
  });
});
