import { describe, expect, it } from "vitest";
import type { StrategyIR } from "../src/strategy/ir";
import { previewCyclesAnalysis } from "../src/strategy/pine/cyclesAnalysisPreview";

const ir: StrategyIR = {
  v: 2,
  name: "Cycles Analysis",
  inputs: [
    { name: "changeInDirectionPercentsInput", value: 20, min: 0.1, max: 100, step: 0.1 },
    { name: "showBackgroundInput", value: 1, min: 0, max: 1, step: 1 },
    { name: "showReversalDetectionPointInput", value: 1, min: 0, max: 1, step: 1 }
  ],
  body: []
};

describe("Cycles Analysis native preview", () => {
  it("draws alternating cycle zones, crest lines, and reversal markers", () => {
    const closes = [100, 120, 140, 130, 105, 90, 70, 85, 110, 125, 100];
    const candles = closes.map((close, i) => ({
      time: i * 60_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100
    }));

    const preview = previewCyclesAnalysis(ir, candles);

    expect(preview).toBeDefined();
    expect(preview?.shapes.vlines.length).toBeGreaterThanOrEqual(2);
    expect(preview?.shapes.boxes.length).toBeGreaterThanOrEqual(3);
    expect(preview?.signals.map((signal) => signal.kind)).toEqual(expect.arrayContaining(["buy", "sell"]));
    expect(preview?.shapes.boxes.at(-1)?.t2).toBe(candles.at(-1)?.time);
  });

  it("does not intercept unrelated imported indicators", () => {
    expect(previewCyclesAnalysis({ ...ir, name: "Other Indicator" }, [])).toBeUndefined();
  });
});
