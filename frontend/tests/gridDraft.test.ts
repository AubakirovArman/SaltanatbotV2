import { describe, expect, it } from "vitest";
import { gridLevelPrices, worstCaseGridCapitalQuote } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import {
  DEFAULT_GRID_DRAFT,
  evaluateGridDraft,
  gridWorstCaseExceeds,
  previewGridLevels,
  type GridDraft
} from "../src/trading/gridDraft";

function draft(overrides: Partial<GridDraft> = {}): GridDraft {
  return { ...DEFAULT_GRID_DRAFT, ...overrides };
}

describe("grid draft evaluation shares the exact server contract", () => {
  it("parses the default draft into canonical grid-params-v1 with the shared worst case and level ladder", () => {
    const evaluation = evaluateGridDraft(draft());
    expect(evaluation.errors).toEqual({});
    expect(evaluation.params).toEqual({
      schemaVersion: "grid-params-v1",
      mode: "neutral",
      spacing: "arithmetic",
      lowerBound: 100,
      upperBound: 200,
      gridLevels: 10,
      orderQuote: 100,
      recenter: "off",
      outsideRangeAction: "pause",
      cooldownSeconds: 300,
      researchOnly: true,
      executionPermission: false
    });
    // 10 levels x 100 USDT x 1.0005 fee reserve.
    expect(evaluation.worstCaseQuote).toBe(1000.5);
    expect(evaluation.worstCaseQuote).toBe(worstCaseGridCapitalQuote(evaluation.params!, PAPER_FILL_MODEL_V1.feePct));
    // The preview ladder is the shared canonical price math, lowest price first.
    expect(evaluation.levels?.map((level) => level.price)).toEqual(gridLevelPrices(evaluation.params!));
    expect(evaluation.levels?.[0]).toEqual({ price: 109.090909, side: "buy" });
    expect(evaluation.levels?.[9]).toEqual({ price: 190.909091, side: "sell" });
  });

  it("keeps optional fields omitted when blank and includes them when provided", () => {
    const withOptionals = evaluateGridDraft(draft({ mode: "long", stopLossPrice: "90", maxCycles: "50" }));
    expect(withOptionals.errors).toEqual({});
    expect(withOptionals.params).toMatchObject({ mode: "long", stopLossPrice: 90, maxCycles: 50 });
    const withoutOptionals = evaluateGridDraft(draft());
    expect(withoutOptionals.params && "stopLossPrice" in withoutOptionals.params).toBe(false);
    expect(withoutOptionals.params && "maxCycles" in withoutOptionals.params).toBe(false);
  });

  it("accepts comma decimals like the rest of the money inputs", () => {
    const evaluation = evaluateGridDraft(draft({ lowerBound: "100,5" }));
    expect(evaluation.errors).toEqual({});
    expect(evaluation.params?.lowerBound).toBe(100.5);
  });

  it("reports per-field issues from the shared contract bounds", () => {
    const evaluation = evaluateGridDraft(draft({
      lowerBound: "0",
      upperBound: "",
      gridLevels: "1",
      orderQuote: "-5",
      stopLossPrice: "junk",
      maxCycles: "0",
      cooldownSeconds: "1.5"
    }));
    expect(evaluation.params).toBeUndefined();
    expect(evaluation.worstCaseQuote).toBeUndefined();
    expect(evaluation.levels).toBeUndefined();
    expect(Object.keys(evaluation.errors).sort()).toEqual([
      "cooldownSeconds",
      "gridLevels",
      "lowerBound",
      "maxCycles",
      "orderQuote",
      "stopLossPrice",
      "upperBound"
    ]);
    expect(evaluation.errors.orderQuote).toMatchObject({ key: "errAboveZeroMax" });
    expect(evaluation.errors.gridLevels).toMatchObject({ key: "errIntegerRange", values: { min: "2", max: "50" } });
    expect(evaluation.errors.maxCycles).toMatchObject({ key: "errIntegerRange", values: { min: "1", max: "10000" } });
  });

  it("rejects inconsistent bounds and per-mode stop-loss placement on the offending field", () => {
    expect(evaluateGridDraft(draft({ lowerBound: "200", upperBound: "100" })).errors)
      .toEqual({ upperBound: { key: "errBoundOrder" } });
    expect(evaluateGridDraft(draft({ spacing: "geometric", lowerBound: "0,000001", upperBound: "1000000000" })).errors)
      .toEqual({ upperBound: { key: "errGeometricRatio" } });
    // Neutral/long stop-loss must sit below the lower bound; short above the upper.
    expect(evaluateGridDraft(draft({ stopLossPrice: "150" })).errors)
      .toEqual({ stopLossPrice: { key: "errStopLossBelowLower" } });
    expect(evaluateGridDraft(draft({ mode: "short", stopLossPrice: "150" })).errors)
      .toEqual({ stopLossPrice: { key: "errStopLossAboveUpper" } });
    expect(evaluateGridDraft(draft({ mode: "short", stopLossPrice: "210" })).errors).toEqual({});
  });

  it("previews indicative sides: long all-buy, short all-sell, neutral split at the spacing midpoint", () => {
    const long = evaluateGridDraft(draft({ mode: "long" }));
    expect(long.levels?.every((level) => level.side === "buy")).toBe(true);
    const short = evaluateGridDraft(draft({ mode: "short" }));
    expect(short.levels?.every((level) => level.side === "sell")).toBe(true);

    // Geometric neutral grids split at the geometric mean, not the midpoint.
    const geometric = evaluateGridDraft(draft({ spacing: "geometric", lowerBound: "100", upperBound: "400", gridLevels: "2" }));
    expect(geometric.params && previewGridLevels(geometric.params)).toEqual([
      { price: 158.740105, side: "buy" },
      { price: 251.98421, side: "sell" }
    ]);
  });

  it("mirrors the server acceptance rule exactly at the micro boundary", () => {
    // Server rule: reject iff round(worstCase * 1e6) > allocationMicros.
    expect(gridWorstCaseExceeds(1000.5, "1000.500000")).toBe(false);
    expect(gridWorstCaseExceeds(1000.5, "1000.499999")).toBe(true);
    expect(gridWorstCaseExceeds(1000.500001, "1000.500000")).toBe(true);
    expect(gridWorstCaseExceeds(1000.5, "1001.000000")).toBe(false);
    expect(gridWorstCaseExceeds(0.000001, "0.000001")).toBe(false);
  });
});
