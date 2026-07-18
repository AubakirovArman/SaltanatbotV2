import type { Locale } from ".";
import { enDca } from "./en/dca";
import { kkDca } from "./kk/dca";
import { ruDca } from "./ru/dca";

export type DcaMessageKey = keyof typeof enDca;

const messages: Record<Locale, Record<DcaMessageKey, string>> = {
  en: enDca,
  ru: ruDca,
  kk: kkDca
};

export function dcaText(locale: Locale, key: DcaMessageKey, values: Record<string, string> = {}): string {
  const template = messages[locale][key] ?? enDca[key];
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement), template);
}

const cycleStates: Record<string, DcaMessageKey> = {
  idle: "stateIdle",
  entering: "stateEntering",
  position: "statePosition",
  exiting: "stateExiting",
  cooldown: "stateCooldown"
};

/** Localizes a known DCA cycle state and passes unknown states through leniently. */
export function dcaCycleStateText(locale: Locale, state: string): string {
  const key = cycleStates[state];
  return key ? dcaText(locale, key) : state;
}
