import { describe, expect, it } from "vitest";
import { worstCaseDcaCapitalQuote } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import {
  DEFAULT_DCA_DRAFT,
  dcaWorstCaseExceeds,
  evaluateDcaDraft,
  type DcaDraft
} from "../src/trading/dcaDraft";

function draft(overrides: Partial<DcaDraft> = {}): DcaDraft {
  return { ...DEFAULT_DCA_DRAFT, ...overrides };
}

describe("dca draft evaluation shares the exact server contract", () => {
  it("parses the default draft into canonical dca-params-v1 with the shared worst case", () => {
    const evaluation = evaluateDcaDraft(draft());
    expect(evaluation.errors).toEqual({});
    expect(evaluation.params).toEqual({
      schemaVersion: "dca-params-v1",
      direction: "long",
      baseOrderQuote: 100,
      safetyOrderQuote: 100,
      maxSafetyOrders: 5,
      priceDeviationPct: 1,
      stepScale: 1.4,
      volumeScale: 1.5,
      takeProfitPct: 1.5,
      cooldownSeconds: 300,
      researchOnly: true,
      executionPermission: false
    });
    // 100 + 100 * (1 + 1.5 + 2.25 + 3.375 + 5.0625) = 1418.75, x 1.0005 fee reserve.
    expect(evaluation.worstCaseQuote).toBe(1419.459375);
    expect(evaluation.worstCaseQuote).toBe(worstCaseDcaCapitalQuote(evaluation.params!, PAPER_FILL_MODEL_V1.feePct));
  });

  it("keeps optional fields omitted when blank and includes them when provided", () => {
    const withOptionals = evaluateDcaDraft(draft({ stopLossPct: "10", trailingTakeProfitPct: "0.5", maxCycleDurationHours: "48" }));
    expect(withOptionals.params).toMatchObject({ stopLossPct: 10, trailingTakeProfitPct: 0.5, maxCycleDurationHours: 48 });
    const withoutOptionals = evaluateDcaDraft(draft());
    expect(withoutOptionals.params && "stopLossPct" in withoutOptionals.params).toBe(false);
    expect(withoutOptionals.params && "maxCycleDurationHours" in withoutOptionals.params).toBe(false);
  });

  it("accepts comma decimals like the rest of the money inputs", () => {
    const evaluation = evaluateDcaDraft(draft({ baseOrderQuote: "100,5" }));
    expect(evaluation.errors).toEqual({});
    expect(evaluation.params?.baseOrderQuote).toBe(100.5);
  });

  it("reports per-field issues from the shared contract bounds", () => {
    const evaluation = evaluateDcaDraft(draft({
      baseOrderQuote: "0",
      safetyOrderQuote: "-1",
      maxSafetyOrders: "26",
      priceDeviationPct: "51",
      stepScale: "0.05",
      volumeScale: "9",
      takeProfitPct: "",
      cooldownSeconds: "1.5",
      maxCycleDurationHours: "721"
    }));
    expect(evaluation.params).toBeUndefined();
    expect(evaluation.worstCaseQuote).toBeUndefined();
    expect(Object.keys(evaluation.errors).sort()).toEqual([
      "baseOrderQuote",
      "cooldownSeconds",
      "maxCycleDurationHours",
      "maxSafetyOrders",
      "priceDeviationPct",
      "safetyOrderQuote",
      "stepScale",
      "takeProfitPct",
      "volumeScale"
    ]);
    expect(evaluation.errors.baseOrderQuote).toMatchObject({ key: "errAboveZeroMax" });
    expect(evaluation.errors.stepScale).toMatchObject({ key: "errNumberRange", values: { min: "0.1", max: "5" } });
    expect(evaluation.errors.maxSafetyOrders).toMatchObject({ key: "errIntegerRange", values: { min: "0", max: "25" } });
  });

  it("rejects a trailing take-profit above the take-profit on the trailing field", () => {
    const evaluation = evaluateDcaDraft(draft({ takeProfitPct: "1", trailingTakeProfitPct: "2" }));
    expect(evaluation.params).toBeUndefined();
    expect(evaluation.errors).toEqual({ trailingTakeProfitPct: { key: "errTrailingAboveTakeProfit" } });
  });

  it("mirrors the server acceptance rule exactly at the micro boundary", () => {
    // Server rule: reject iff round(worstCase * 1e6) > allocationMicros.
    expect(dcaWorstCaseExceeds(450.225, "450.225000")).toBe(false);
    expect(dcaWorstCaseExceeds(450.225, "450.224999")).toBe(true);
    expect(dcaWorstCaseExceeds(450.225001, "450.225000")).toBe(true);
    expect(dcaWorstCaseExceeds(450.225, "451.000000")).toBe(false);
    expect(dcaWorstCaseExceeds(0.000001, "0.000001")).toBe(false);
  });
});
