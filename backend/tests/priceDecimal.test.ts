import { describe, expect, it } from "vitest";
import { priceMatchesThreshold } from "../src/alerts/priceDecimal.js";

describe("exact price threshold decimal comparison", () => {
  it("does not round a higher-precision threshold onto the observed JS price", () => {
    const observed = 64_703.52;
    expect(priceMatchesThreshold(observed, "64703.520000000001", "above")).toBe(false);
    expect(priceMatchesThreshold(observed, "64703.520000000001", "below")).toBe(true);
    expect(priceMatchesThreshold(observed, "64703.519999999999", "above")).toBe(true);
    expect(priceMatchesThreshold(observed, "64703.519999999999", "below")).toBe(false);
  });

  it("keeps inclusive equality and expands the shortest exponent representation", () => {
    expect(priceMatchesThreshold(64_703.52, "64703.52", "above")).toBe(true);
    expect(priceMatchesThreshold(64_703.52, "64703.52", "below")).toBe(true);
    expect(priceMatchesThreshold(1e-8, "0.00000001", "above")).toBe(true);
    expect(priceMatchesThreshold(1e-8, "0.00000001", "below")).toBe(true);
  });

  it("fails malformed, zero and non-finite inputs closed", () => {
    expect(priceMatchesThreshold(Number.NaN, "1", "above")).toBe(false);
    expect(priceMatchesThreshold(1, "1e9999999", "above")).toBe(false);
    expect(priceMatchesThreshold(1, "0", "below")).toBe(false);
  });
});
