import { describe, expect, it } from "vitest";
import { gridModeText, gridPhaseText, gridSpacingText, gridText, type GridMessageKey } from "../src/i18n/grid";
import { enGrid } from "../src/i18n/en/grid";
import { kkGrid } from "../src/i18n/kk/grid";
import { ruGrid } from "../src/i18n/ru/grid";

const catalogs = { en: enGrid, ru: ruGrid, kk: kkGrid } as const;

describe("grid message catalog parity", () => {
  it("keeps identical, non-empty key sets across en, ru and kk", () => {
    const keys = Object.keys(enGrid).sort();
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("preserves every substitution placeholder in every locale", () => {
    for (const [key, template] of Object.entries(enGrid) as Array<[GridMessageKey, string]>) {
      const placeholders = [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[0]).sort();
      for (const locale of ["ru", "kk"] as const) {
        const localized = [...catalogs[locale][key].matchAll(/\{(\w+)\}/gu)].map((match) => match[0]).sort();
        expect(localized, `${locale}.${key}`).toEqual(placeholders);
      }
    }
  });

  it("substitutes values and localizes known phases, modes and spacings while passing unknowns through", () => {
    expect(gridText("en", "errIntegerRange", { min: "2", max: "50" })).toBe("Enter a whole number from 2 to 50.");
    expect(gridText("ru", "candleHelp", { timeframe: "5m" })).toContain("5m");
    expect(gridText("en", "levelPreviewCount", { count: "10" })).toBe("10 levels");
    expect(gridPhaseText("en", "active")).toBe(enGrid.phaseActive);
    expect(gridPhaseText("ru", "paused")).toBe(ruGrid.phasePaused);
    expect(gridPhaseText("kk", "stopped")).toBe(kkGrid.phaseStopped);
    expect(gridModeText("ru", "neutral")).toBe(ruGrid.modeNeutral);
    expect(gridSpacingText("kk", "geometric")).toBe(kkGrid.spacingGeometric);
    // Unknown or newer server values render leniently instead of crashing.
    expect(gridPhaseText("en", "future-phase")).toBe("future-phase");
    expect(gridModeText("kk", "hedged")).toBe("hedged");
    expect(gridSpacingText("en", "fibonacci")).toBe("fibonacci");
  });
});
