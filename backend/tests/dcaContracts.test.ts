import { describe, expect, it } from "vitest";
import {
  DCA_PARAMS_SCHEMA_V1,
  parseDcaParamsV1,
  worstCaseDcaCapitalQuote,
  type DcaParamsV1
} from "@saltanatbotv2/contracts";
import { DEFAULT_BACKTEST_CONFIG } from "@saltanatbotv2/backtest-core";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "dca-params-v1",
    direction: "long",
    baseOrderQuote: 100,
    safetyOrderQuote: 50,
    maxSafetyOrders: 3,
    priceDeviationPct: 1.5,
    stepScale: 1.2,
    volumeScale: 2,
    takeProfitPct: 2,
    cooldownSeconds: 300,
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

describe("canonical dca-params-v1 contract", () => {
  it("parses a canonical payload and preserves optional fields exactly", () => {
    expect(parseDcaParamsV1(params())).toEqual(params());
    const full = params({
      direction: "short",
      stopLossPct: 15,
      trailingTakeProfitPct: 0.5,
      maxCycleDurationHours: 72
    });
    expect(parseDcaParamsV1(full)).toEqual(full);
    expect(DCA_PARAMS_SCHEMA_V1).toBe("dca-params-v1");
  });

  it("rejects payloads outside the versioned research-only safety envelope", () => {
    expect(() => parseDcaParamsV1(params({ schemaVersion: "dca-params-v2" }))).toThrow(/safety envelope/);
    expect(() => parseDcaParamsV1(params({ researchOnly: false }))).toThrow(/safety envelope/);
    expect(() => parseDcaParamsV1(params({ executionPermission: true }))).toThrow(/safety envelope/);
    expect(() => parseDcaParamsV1(params({ extra: 1 }))).toThrow(/missing or unknown/);
    expect(() => parseDcaParamsV1(params({ takeProfitPct: undefined }))).toThrow();
    expect(() => parseDcaParamsV1([])).toThrow(/must be an object/);
  });

  it("rejects out-of-bounds numbers on every validated field", () => {
    expect(() => parseDcaParamsV1(params({ direction: "up" }))).toThrow(/direction/);
    expect(() => parseDcaParamsV1(params({ baseOrderQuote: 0 }))).toThrow(/baseOrderQuote/);
    expect(() => parseDcaParamsV1(params({ safetyOrderQuote: -1 }))).toThrow(/safetyOrderQuote/);
    expect(() => parseDcaParamsV1(params({ baseOrderQuote: 1_000_000_001 }))).toThrow(/baseOrderQuote/);
    expect(() => parseDcaParamsV1(params({ maxSafetyOrders: 26 }))).toThrow(/maxSafetyOrders/);
    expect(() => parseDcaParamsV1(params({ maxSafetyOrders: 1.5 }))).toThrow(/maxSafetyOrders/);
    expect(() => parseDcaParamsV1(params({ priceDeviationPct: 0 }))).toThrow(/priceDeviationPct/);
    expect(() => parseDcaParamsV1(params({ priceDeviationPct: 50.1 }))).toThrow(/priceDeviationPct/);
    expect(() => parseDcaParamsV1(params({ stepScale: 0.05 }))).toThrow(/stepScale/);
    expect(() => parseDcaParamsV1(params({ volumeScale: 5.5 }))).toThrow(/volumeScale/);
    expect(() => parseDcaParamsV1(params({ takeProfitPct: 0 }))).toThrow(/takeProfitPct/);
    expect(() => parseDcaParamsV1(params({ takeProfitPct: 101 }))).toThrow(/takeProfitPct/);
    expect(() => parseDcaParamsV1(params({ stopLossPct: 0 }))).toThrow(/stopLossPct/);
    expect(() => parseDcaParamsV1(params({ trailingTakeProfitPct: 2.5 }))).toThrow(/trailingTakeProfitPct/);
    expect(() => parseDcaParamsV1(params({ cooldownSeconds: -1 }))).toThrow(/cooldownSeconds/);
    expect(() => parseDcaParamsV1(params({ cooldownSeconds: 86_401 }))).toThrow(/cooldownSeconds/);
    expect(() => parseDcaParamsV1(params({ maxCycleDurationHours: 0 }))).toThrow(/maxCycleDurationHours/);
    expect(() => parseDcaParamsV1(params({ maxCycleDurationHours: 721 }))).toThrow(/maxCycleDurationHours/);
    expect(() => parseDcaParamsV1(params({ baseOrderQuote: Number.NaN }))).toThrow(/baseOrderQuote/);
  });

  it("computes golden worst-case capital values with a conservative fee reserve", () => {
    const base = parseDcaParamsV1(params()) as DcaParamsV1;
    // 100 + (50 + 100 + 200) = 450, times 1.0005, ceiled to 6 decimals.
    expect(worstCaseDcaCapitalQuote(base, 0.05)).toBe(450.225);
    expect(worstCaseDcaCapitalQuote({ ...base, maxSafetyOrders: 0 }, 0.05)).toBe(100.05);
    // 100 + 50 * (1 + 1.5 + 2.25 + 3.375) = 506.25 with no fee reserve.
    expect(worstCaseDcaCapitalQuote({ ...base, volumeScale: 1.5, maxSafetyOrders: 4 }, 0)).toBe(506.25);
    // Flat volume scale: 10 + 25 * 10 = 260, times 1.0005.
    expect(worstCaseDcaCapitalQuote({ ...base, baseOrderQuote: 10, safetyOrderQuote: 10, volumeScale: 1, maxSafetyOrders: 25 }, 0.05)).toBe(260.13);
    expect(() => worstCaseDcaCapitalQuote(base, Number.NaN)).toThrow(/feePct/);
    expect(() => worstCaseDcaCapitalQuote(base, -1)).toThrow(/feePct/);
  });

  it("keeps the shared paper fill model as the single fee/slippage parity source", () => {
    expect(PAPER_FILL_MODEL_V1).toEqual({ version: "paper-fill-model-v1", feePct: 0.05, slipPct: 0.02 });
    expect(DEFAULT_BACKTEST_CONFIG.commissionPct).toBe(PAPER_FILL_MODEL_V1.feePct);
    expect(DEFAULT_BACKTEST_CONFIG.slippagePct).toBe(PAPER_FILL_MODEL_V1.slipPct);
  });
});
