import { describe, expect, it } from "vitest";
import {
  GRID_PARAMS_SCHEMA_V1,
  gridLevelPrices,
  parseGridParamsV1,
  worstCaseGridCapitalQuote,
  type GridParamsV1
} from "@saltanatbotv2/contracts";

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "grid-params-v1",
    mode: "neutral",
    spacing: "arithmetic",
    lowerBound: 100,
    upperBound: 200,
    gridLevels: 4,
    orderQuote: 50,
    outsideRangeAction: "pause",
    cooldownSeconds: 60,
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

describe("canonical grid-params-v1 contract", () => {
  it("parses a canonical payload, defaults recenter off, and preserves optional fields exactly", () => {
    expect(parseGridParamsV1(params())).toEqual({ ...params(), recenter: "off" });
    const full = params({
      mode: "long",
      spacing: "geometric",
      recenter: "off",
      outsideRangeAction: "stop",
      stopLossPrice: 90,
      maxCycles: 25
    });
    expect(parseGridParamsV1(full)).toEqual(full);
    expect(GRID_PARAMS_SCHEMA_V1).toBe("grid-params-v1");
  });

  it("rejects payloads outside the versioned research-only safety envelope", () => {
    expect(() => parseGridParamsV1(params({ schemaVersion: "grid-params-v2" }))).toThrow(/safety envelope/);
    expect(() => parseGridParamsV1(params({ researchOnly: false }))).toThrow(/safety envelope/);
    expect(() => parseGridParamsV1(params({ executionPermission: true }))).toThrow(/safety envelope/);
    expect(() => parseGridParamsV1(params({ extra: 1 }))).toThrow(/missing or unknown/);
    expect(() => parseGridParamsV1(params({ orderQuote: undefined }))).toThrow();
    expect(() => parseGridParamsV1([])).toThrow(/must be an object/);
    expect(() => parseGridParamsV1(params({ recenter: "manual" }))).toThrow(/recenter/);
  });

  it("rejects out-of-bounds numbers and inconsistent bound ordering per mode", () => {
    expect(() => parseGridParamsV1(params({ mode: "sideways" }))).toThrow(/mode/);
    expect(() => parseGridParamsV1(params({ spacing: "fibonacci" }))).toThrow(/spacing/);
    expect(() => parseGridParamsV1(params({ outsideRangeAction: "recenter" }))).toThrow(/outsideRangeAction/);
    expect(() => parseGridParamsV1(params({ lowerBound: 0 }))).toThrow(/lowerBound/);
    expect(() => parseGridParamsV1(params({ upperBound: 1_000_000_001 }))).toThrow(/upperBound/);
    expect(() => parseGridParamsV1(params({ lowerBound: 200, upperBound: 100 }))).toThrow(/strictly below/);
    expect(() => parseGridParamsV1(params({ lowerBound: 100, upperBound: 100 }))).toThrow(/strictly below/);
    expect(() => parseGridParamsV1(params({ spacing: "geometric", lowerBound: 0.000001, upperBound: 1_000_000 })))
      .toThrow(/geometric bounds ratio/);
    expect(parseGridParamsV1(params({ lowerBound: 0.000001, upperBound: 1_000_000 }))).toBeTruthy();
    expect(() => parseGridParamsV1(params({ gridLevels: 1 }))).toThrow(/gridLevels/);
    expect(() => parseGridParamsV1(params({ gridLevels: 51 }))).toThrow(/gridLevels/);
    expect(() => parseGridParamsV1(params({ gridLevels: 2.5 }))).toThrow(/gridLevels/);
    expect(() => parseGridParamsV1(params({ orderQuote: 0 }))).toThrow(/orderQuote/);
    expect(() => parseGridParamsV1(params({ orderQuote: 1_000_000_001 }))).toThrow(/orderQuote/);
    expect(() => parseGridParamsV1(params({ cooldownSeconds: -1 }))).toThrow(/cooldownSeconds/);
    expect(() => parseGridParamsV1(params({ cooldownSeconds: 86_401 }))).toThrow(/cooldownSeconds/);
    expect(() => parseGridParamsV1(params({ maxCycles: 0 }))).toThrow(/maxCycles/);
    expect(() => parseGridParamsV1(params({ maxCycles: 10_001 }))).toThrow(/maxCycles/);
    expect(() => parseGridParamsV1(params({ lowerBound: Number.NaN }))).toThrow(/lowerBound/);
    // Stop-loss ordering: neutral/long below the lower bound, short above the upper bound.
    expect(() => parseGridParamsV1(params({ stopLossPrice: 0 }))).toThrow(/stopLossPrice/);
    expect(() => parseGridParamsV1(params({ stopLossPrice: 100 }))).toThrow(/stopLossPrice/);
    expect(() => parseGridParamsV1(params({ mode: "long", stopLossPrice: 150 }))).toThrow(/stopLossPrice/);
    expect(() => parseGridParamsV1(params({ mode: "short", stopLossPrice: 200 }))).toThrow(/stopLossPrice/);
    expect(parseGridParamsV1(params({ stopLossPrice: 99.999999 }))).toMatchObject({ stopLossPrice: 99.999999 });
    expect(parseGridParamsV1(params({ mode: "short", stopLossPrice: 210 }))).toMatchObject({ stopLossPrice: 210 });
  });

  it("computes golden deterministic level prices for arithmetic and geometric spacing", () => {
    const arithmetic = parseGridParamsV1(params()) as GridParamsV1;
    // lower + i * (upper - lower) / (levels + 1), i = 1..4: strictly inside the range.
    expect(gridLevelPrices(arithmetic)).toEqual([120, 140, 160, 180]);
    const geometric = parseGridParamsV1(params({ spacing: "geometric" })) as GridParamsV1;
    // lower * (upper / lower) ^ (i / (levels + 1)) = 100 * 2^(i/5), 6-decimal canonical rounding.
    expect(gridLevelPrices(geometric)).toEqual([114.869835, 131.950791, 151.571657, 174.110113]);
    // Micro-priced geometric grids stay canonical at 6 decimals.
    const tiny = parseGridParamsV1(params({ spacing: "geometric", lowerBound: 0.01, upperBound: 0.04, gridLevels: 2 })) as GridParamsV1;
    expect(gridLevelPrices(tiny)).toEqual([0.015874, 0.025198]);
    // Byte-stable determinism: repeated evaluation yields the identical ladder.
    expect(JSON.stringify(gridLevelPrices(geometric))).toBe(JSON.stringify(gridLevelPrices(geometric)));
  });

  it("computes golden worst-case capital values with a conservative fee reserve", () => {
    const base = parseGridParamsV1(params()) as GridParamsV1;
    // 4 levels x 50 = 200, times 1.0005, ceiled to 6 decimals.
    expect(worstCaseGridCapitalQuote(base, 0.05)).toBe(200.1);
    expect(worstCaseGridCapitalQuote(base, 0)).toBe(200);
    // Rounding is always UP: 3 x 33.333333 x 1.0005 = 100.0499989995 -> 100.049999.
    expect(worstCaseGridCapitalQuote({ ...base, gridLevels: 3, orderQuote: 33.333333 }, 0.05)).toBe(100.049999);
    // The quote-denominated MVP reserve is identical for every mode.
    expect(worstCaseGridCapitalQuote({ ...base, mode: "long" }, 0.05)).toBe(200.1);
    expect(worstCaseGridCapitalQuote({ ...base, mode: "short" }, 0.05)).toBe(200.1);
    expect(() => worstCaseGridCapitalQuote(base, Number.NaN)).toThrow(/feePct/);
    expect(() => worstCaseGridCapitalQuote(base, -1)).toThrow(/feePct/);
  });
});
