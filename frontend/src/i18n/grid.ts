import type { Locale } from ".";
import { enGrid } from "./en/grid";
import { kkGrid } from "./kk/grid";
import { ruGrid } from "./ru/grid";

export type GridMessageKey = keyof typeof enGrid;

const messages: Record<Locale, Record<GridMessageKey, string>> = {
  en: enGrid,
  ru: ruGrid,
  kk: kkGrid
};

export function gridText(locale: Locale, key: GridMessageKey, values: Record<string, string> = {}): string {
  const template = messages[locale][key] ?? enGrid[key];
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement), template);
}

const phases: Record<string, GridMessageKey> = {
  idle: "phaseIdle",
  active: "phaseActive",
  paused: "phasePaused",
  stopped: "phaseStopped"
};

/** Localizes a known grid phase and passes unknown phases through leniently. */
export function gridPhaseText(locale: Locale, phase: string): string {
  const key = phases[phase];
  return key ? gridText(locale, key) : phase;
}

const modes: Record<string, GridMessageKey> = {
  neutral: "modeNeutral",
  long: "modeLong",
  short: "modeShort"
};

/** Localizes a known grid mode and passes unknown modes through leniently. */
export function gridModeText(locale: Locale, mode: string): string {
  const key = modes[mode];
  return key ? gridText(locale, key) : mode;
}

const spacings: Record<string, GridMessageKey> = {
  arithmetic: "spacingArithmetic",
  geometric: "spacingGeometric"
};

/** Localizes a known spacing law and passes unknown values through leniently. */
export function gridSpacingText(locale: Locale, spacing: string): string {
  const key = spacings[spacing];
  return key ? gridText(locale, key) : spacing;
}
