import { describe, expect, it } from "vitest";
import { classifyCandleSequence } from "../src/trading/candleSequence.js";

describe("live candle sequence disaster guard", () => {
  it("classifies initial, same, next, missing and stale updates deterministically", () => {
    expect(classifyCandleSequence(undefined, 0, 60_000)).toEqual({ kind: "initial" });
    expect(classifyCandleSequence(60_000, 60_000, 60_000)).toEqual({ kind: "same" });
    expect(classifyCandleSequence(60_000, 120_000, 60_000)).toEqual({ kind: "next" });
    expect(classifyCandleSequence(60_000, 240_000, 60_000)).toEqual({ kind: "gap", missingBars: 2 });
    expect(classifyCandleSequence(120_000, 60_000, 60_000)).toEqual({ kind: "stale", lagMs: 60_000 });
  });

  it("does not infer negative gaps from malformed interval configuration", () => {
    expect(classifyCandleSequence(10, 11, 0)).toEqual({ kind: "next" });
  });
});
