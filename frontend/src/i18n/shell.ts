import type { Locale } from ".";
import { enShell } from "./en/shell";
import { kkShell } from "./kk/shell";
import { ruShell } from "./ru/shell";

export type ShellMessageKey = keyof typeof enShell;

const messages: Record<Locale, Record<ShellMessageKey, string>> = {
  en: enShell,
  ru: ruShell,
  kk: kkShell
};

export function shellText(locale: Locale, key: ShellMessageKey): string {
  return messages[locale][key] ?? enShell[key];
}
