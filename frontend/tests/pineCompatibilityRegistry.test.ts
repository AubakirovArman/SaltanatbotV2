import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY_REGISTRY, PINE_COMPATIBILITY_SUMMARY } from "../src/strategy/pine/generatedCompatibility";

describe("generated Pine compatibility registry", () => {
  it("contains unique corpus features and all four fidelity levels", () => {
    expect(PINE_COMPATIBILITY_REGISTRY).toHaveLength(178);
    expect(new Set(PINE_COMPATIBILITY_REGISTRY.map((entry) => entry.feature.toLowerCase())).size).toBe(PINE_COMPATIBILITY_REGISTRY.length);
    expect(PINE_COMPATIBILITY_SUMMARY).toEqual({ exact: 125, "display-only": 26, approximation: 22, rejected: 5 });
    expect(Object.values(PINE_COMPATIBILITY_SUMMARY).reduce((sum, count) => sum + count, 0)).toBe(PINE_COMPATIBILITY_REGISTRY.length);
  });

  it("does not label supported drawings rejected merely because they occur in a rejected script", () => {
    expect(PINE_COMPATIBILITY_REGISTRY.find((entry) => entry.feature === "label.new")?.level).toBe("display-only");
    expect(PINE_COMPATIBILITY_REGISTRY.find((entry) => entry.feature === "ta.pivothigh")?.level).toBe("rejected");
  });
});
