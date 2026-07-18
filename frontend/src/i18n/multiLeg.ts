import type { Locale } from ".";
import { enMultiLeg } from "./en/multiLeg";
import { kkMultiLeg } from "./kk/multiLeg";
import { ruMultiLeg } from "./ru/multiLeg";

export type MultiLegMessageKey = keyof typeof enMultiLeg;

const messages: Record<Locale, Record<MultiLegMessageKey, string>> = {
  en: enMultiLeg,
  ru: ruMultiLeg,
  kk: kkMultiLeg
};

export function multiLegText(locale: Locale, key: MultiLegMessageKey): string {
  return messages[locale][key] ?? enMultiLeg[key];
}

const outcomes: Record<string, MultiLegMessageKey> = {
  completed: "outcomeCompleted",
  compensated: "outcomeCompensated",
  "aborted-no-exposure": "outcomeAborted",
  "manual-review-required": "outcomeManualReview"
};

/** Localizes a known terminal outcome and passes unknown outcomes through leniently. */
export function multiLegOutcomeText(locale: Locale, outcome: string): string {
  const key = outcomes[outcome];
  return key ? multiLegText(locale, key) : outcome;
}

const statuses: Record<string, MultiLegMessageKey> = {
  running: "statusRunning",
  terminal: "statusTerminal"
};

/** Localizes a known intent status and passes unknown statuses through leniently. */
export function multiLegStatusText(locale: Locale, status: string): string {
  const key = statuses[status];
  return key ? multiLegText(locale, key) : status;
}
