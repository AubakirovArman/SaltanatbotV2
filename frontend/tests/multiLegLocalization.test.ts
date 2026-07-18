import { describe, expect, it } from "vitest";
import { multiLegOutcomeText, multiLegStatusText, multiLegText } from "../src/i18n/multiLeg";
import { enMultiLeg } from "../src/i18n/en/multiLeg";
import { kkMultiLeg } from "../src/i18n/kk/multiLeg";
import { ruMultiLeg } from "../src/i18n/ru/multiLeg";

const catalogs = { en: enMultiLeg, ru: ruMultiLeg, kk: kkMultiLeg } as const;

describe("multi-leg message catalog parity", () => {
  it("keeps identical, non-empty key sets across en, ru and kk", () => {
    const keys = Object.keys(enMultiLeg).sort();
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("localizes every message key in every locale", () => {
    expect(multiLegText("en", "runAction")).toBe(enMultiLeg.runAction);
    expect(multiLegText("ru", "runAction")).toBe(ruMultiLeg.runAction);
    expect(multiLegText("kk", "runAction")).toBe(kkMultiLeg.runAction);
    expect(multiLegText("ru", "pnlNote")).toBe(ruMultiLeg.pnlNote);
    expect(multiLegText("kk", "residualNote")).toBe(kkMultiLeg.residualNote);
  });

  it("localizes known outcomes and statuses while passing unknown server values through", () => {
    expect(multiLegOutcomeText("en", "completed")).toBe(enMultiLeg.outcomeCompleted);
    expect(multiLegOutcomeText("ru", "compensated")).toBe(ruMultiLeg.outcomeCompensated);
    expect(multiLegOutcomeText("kk", "manual-review-required")).toBe(kkMultiLeg.outcomeManualReview);
    expect(multiLegOutcomeText("ru", "aborted-no-exposure")).toBe(ruMultiLeg.outcomeAborted);
    expect(multiLegStatusText("en", "running")).toBe(enMultiLeg.statusRunning);
    expect(multiLegStatusText("kk", "terminal")).toBe(kkMultiLeg.statusTerminal);
    // Newer server values render leniently instead of crashing.
    expect(multiLegOutcomeText("en", "future-outcome")).toBe("future-outcome");
    expect(multiLegStatusText("ru", "future-status")).toBe("future-status");
  });
});
