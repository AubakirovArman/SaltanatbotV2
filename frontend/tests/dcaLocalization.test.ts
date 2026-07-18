import { describe, expect, it } from "vitest";
import { dcaCycleStateText, dcaText, type DcaMessageKey } from "../src/i18n/dca";
import { enDca } from "../src/i18n/en/dca";
import { kkDca } from "../src/i18n/kk/dca";
import { ruDca } from "../src/i18n/ru/dca";

const catalogs = { en: enDca, ru: ruDca, kk: kkDca } as const;

describe("dca message catalog parity", () => {
  it("keeps identical, non-empty key sets across en, ru and kk", () => {
    const keys = Object.keys(enDca).sort();
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("preserves every substitution placeholder in every locale", () => {
    for (const [key, template] of Object.entries(enDca) as Array<[DcaMessageKey, string]>) {
      const placeholders = [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[0]).sort();
      for (const locale of ["ru", "kk"] as const) {
        const localized = [...catalogs[locale][key].matchAll(/\{(\w+)\}/gu)].map((match) => match[0]).sort();
        expect(localized, `${locale}.${key}`).toEqual(placeholders);
      }
    }
  });

  it("substitutes values and localizes known cycle states while passing unknown states through", () => {
    expect(dcaText("en", "errIntegerRange", { min: "0", max: "25" })).toBe("Enter a whole number from 0 to 25.");
    expect(dcaText("ru", "candleHelp", { timeframe: "5m" })).toContain("5m");
    expect(dcaCycleStateText("en", "position")).toBe(enDca.statePosition);
    expect(dcaCycleStateText("ru", "cooldown")).toBe(ruDca.stateCooldown);
    expect(dcaCycleStateText("kk", "idle")).toBe(kkDca.stateIdle);
    // Unknown or newer server states render leniently instead of crashing.
    expect(dcaCycleStateText("en", "stopped")).toBe("stopped");
    expect(dcaCycleStateText("kk", "future-state")).toBe("future-state");
  });
});
