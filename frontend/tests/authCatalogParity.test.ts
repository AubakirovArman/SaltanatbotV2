import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const catalogs = ["en", "ru", "kk"].map((locale) => ({
  locale,
  messages: JSON.parse(readFileSync(new URL(`../public/auth-i18n/${locale}.json`, import.meta.url), "utf8")) as Record<string, string>
}));

describe("authentication catalog parity", () => {
  it("keeps EN, RU and KK keys identical and every value non-empty", () => {
    const expected = Object.keys(catalogs[0]!.messages).sort();
    for (const catalog of catalogs) {
      expect(Object.keys(catalog.messages).sort(), catalog.locale).toEqual(expected);
      expect(Object.values(catalog.messages).every((value) => typeof value === "string" && value.trim().length > 0), catalog.locale).toBe(true);
    }
  });
});
