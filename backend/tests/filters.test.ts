import { describe, expect, it } from "vitest";
import {
  checkMinimums,
  roundToStep,
  roundToTick,
  type SymbolFilters
} from "../src/trading/exchange/filters.js";

/**
 * Pure rounding logic that keeps live orders inside the venue's LOT_SIZE /
 * PRICE_FILTER / MIN_NOTIONAL rules (Binance -1013 rejections). No network here
 * — the cache loaders are exercised only against these deterministic helpers.
 */

describe("roundToStep", () => {
  it("floors to the nearest step", () => {
    expect(roundToStep(1.23456, 0.001)).toBe(1.234);
    expect(roundToStep(3.9, 1)).toBe(3);
    expect(roundToStep(0.007, 0.005)).toBe(0.005);
    expect(roundToStep(123.456, 0.1)).toBe(123.4);
  });

  it("keeps exact multiples unchanged", () => {
    expect(roundToStep(1.234, 0.001)).toBe(1.234);
    expect(roundToStep(5, 1)).toBe(5);
    expect(roundToStep(0.5, 0.25)).toBe(0.5);
  });

  it("cancels binary float error", () => {
    // 0.1 + 0.2 = 0.30000000000000004; must not floor to 0.29.
    expect(roundToStep(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(roundToStep(0.29 + 0.001, 0.001)).toBe(0.291);
    // A value that is an exact multiple but arrived via float noise.
    expect(roundToStep(0.3, 0.1)).toBe(0.3);
  });

  it("handles very small steps (scientific notation)", () => {
    expect(roundToStep(0.123456789, 1e-8)).toBeCloseTo(0.12345678, 10);
    expect(roundToStep(0.000000015, 0.00000001)).toBeCloseTo(0.00000001, 12);
  });

  it("passes value through for zero / negative / undefined step", () => {
    expect(roundToStep(1.23456, 0)).toBe(1.23456);
    expect(roundToStep(1.23456, undefined)).toBe(1.23456);
    expect(roundToStep(1.23456, -1)).toBe(1.23456);
    expect(roundToStep(1.23456, NaN)).toBe(1.23456);
  });

  it("passes non-finite values through", () => {
    expect(roundToStep(NaN, 0.1)).toBeNaN();
    expect(roundToStep(Infinity, 0.1)).toBe(Infinity);
  });
});

describe("roundToTick", () => {
  it("floors a price to the nearest tick", () => {
    expect(roundToTick(61862.037, 0.01)).toBe(61862.03);
    expect(roundToTick(61862.037, 0.1)).toBe(61862);
    expect(roundToTick(0.123456, 0.0001)).toBe(0.1234);
  });

  it("keeps exact multiples and passes through no-tick", () => {
    expect(roundToTick(61862.03, 0.01)).toBe(61862.03);
    expect(roundToTick(61862.037, undefined)).toBe(61862.037);
    expect(roundToTick(61862.037, 0)).toBe(61862.037);
  });
});

describe("checkMinimums", () => {
  const filters: SymbolFilters = { stepSize: 0.001, tickSize: 0.01, minQty: 0.001, minNotional: 5 };

  it("passes an order that meets both minimums", () => {
    expect(checkMinimums(0.01, 1000, filters)).toBeUndefined(); // notional 10 >= 5
  });

  it("rejects below minQty", () => {
    const reason = checkMinimums(0.0005, 1000, filters);
    expect(reason).toMatch(/minQty/);
  });

  it("rejects below minNotional", () => {
    const reason = checkMinimums(0.001, 1000, filters); // notional 1 < 5
    expect(reason).toMatch(/minNotional/);
  });

  it("is a no-op when filters are unavailable", () => {
    expect(checkMinimums(0.00001, 1, undefined)).toBeUndefined();
  });

  it("ignores minimums that are zero / unset", () => {
    const partial: SymbolFilters = { stepSize: 0.001, tickSize: 0.01, minQty: 0, minNotional: 0 };
    expect(checkMinimums(0.00000001, 0.00001, partial)).toBeUndefined();
  });
});
