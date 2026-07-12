import { describe, expect, it } from "vitest";
import { createDefaultIndicators } from "../src/chart/defaultIndicators";
import { applyPaneIndicatorOverrides, capturePaneIndicatorOverrides, normalizePaneIndicatorOverrides } from "../src/chart/paneIndicators";

describe("per-pane indicator overrides", () => {
  it("captures independent settings and retains canonical indicator logic", () => {
    const source = createDefaultIndicators().map((indicator) => indicator.id === "sma-20"
      ? { ...indicator, logicCode: "canonical-code", period: 33 }
      : indicator);
    const overrides = capturePaneIndicatorOverrides(source).map((override) => override.id === "sma-20"
      ? { ...override, enabled: false, period: 55 }
      : override.id === "ema-50" ? { ...override, enabled: true } : override);
    const applied = applyPaneIndicatorOverrides(source, overrides);

    expect(applied.find((indicator) => indicator.id === "sma-20")).toMatchObject({ enabled: false, period: 55, logicCode: "canonical-code" });
    expect(applied.find((indicator) => indicator.id === "ema-50")).toMatchObject({ enabled: true, period: 50 });
  });

  it("treats the override list as authoritative and normalizes untrusted storage", () => {
    const normalized = normalizePaneIndicatorOverrides([
      { id: "sma-20", enabled: true, period: 999_999, color: "#abcdef", pane: "main" },
      { id: "sma-20", enabled: false },
      { id: "bad", enabled: true, color: "url(javascript:bad)", scalePlacement: "outside" },
      { id: "", enabled: true }
    ]);
    expect(normalized).toEqual([
      { id: "sma-20", enabled: true, pane: "main", color: "#abcdef", period: 10_000 },
      { id: "bad", enabled: true }
    ]);
    const applied = applyPaneIndicatorOverrides(createDefaultIndicators(), normalized);
    expect(applied.find((indicator) => indicator.id === "bb-20")?.enabled).toBe(false);
    expect(normalizePaneIndicatorOverrides(Array.from({ length: 40 }, (_, index) => ({ id: `custom-${index}`, enabled: true })))).toHaveLength(32);
  });
});
