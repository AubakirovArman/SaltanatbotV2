// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadLocale, localeDirection, localeNames, localeTag, localized, nextLocale, storeLocale, supportedLocales, translate } from "../src/i18n";

describe("locale registry", () => {
  beforeEach(() => localStorage.clear());

  it("cycles all supported languages in a stable order", () => {
    expect(supportedLocales).toEqual(["en", "ru", "kk"]);
    expect(nextLocale("en")).toBe("ru");
    expect(nextLocale("ru")).toBe("kk");
    expect(nextLocale("kk")).toBe("en");
    expect(localeNames).toEqual({ en: "English", ru: "Русский", kk: "Қазақша" });
  });

  it("persists Kazakh and exposes browser metadata", () => {
    storeLocale("kk");
    expect(loadLocale()).toBe("kk");
    expect(localeTag("kk")).toBe("kk-KZ");
    expect(localeDirection("kk")).toBe("ltr");
    expect(translate("kk", "chart")).toBe("График");
    expect(localized("kk", { en: "one", ru: "два", kk: "үш" })).toBe("үш");
  });
});
