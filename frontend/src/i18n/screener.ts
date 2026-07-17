import type { Locale } from ".";
import { enScreener } from "./en/screener";
import { kkScreener } from "./kk/screener";
import { ruScreener } from "./ru/screener";

export type ScreenerMessageKey = keyof typeof enScreener;

const messages: Record<Locale, Record<ScreenerMessageKey, string>> = {
  en: enScreener,
  ru: ruScreener,
  kk: kkScreener
};

export function screenerText(locale: Locale, key: ScreenerMessageKey, values: Record<string, string> = {}): string {
  const template = messages[locale][key] ?? enScreener[key];
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement), template);
}
