import type { GeneratorMaKind, StrategyFamily, TradeDirection } from "./types.js";

export type GeneratorRandom = () => number;

/** Mulberry32 keeps runs independent of clock and global Math.random state. */
export function createGeneratorRandom(seed: number): GeneratorRandom {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function pick<T>(values: readonly T[], random: GeneratorRandom): T {
  if (!values.length) throw new Error("Cannot pick from an empty generator choice set");
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

export function randomInt(random: GeneratorRandom, min: number, max: number, step = 1): number {
  const safeStep = Math.max(1, Math.floor(step));
  const slots = Math.floor((max - min) / safeStep) + 1;
  return min + Math.floor(random() * slots) * safeStep;
}

export function randomDecimal(random: GeneratorRandom, min: number, max: number, step: number): number {
  const slots = Math.floor((max - min) / step) + 1;
  return canonicalNumber(min + Math.floor(random() * slots) * step);
}

export function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Generator values must be finite");
  return Object.is(value, -0) ? 0 : Number.parseFloat(value.toPrecision(12));
}

export const ALL_FAMILIES: readonly StrategyFamily[] = ["trend", "mean-reversion", "breakout", "momentum"];
export const ALL_DIRECTIONS: readonly TradeDirection[] = ["long", "short"];
export const ALL_MA_KINDS: readonly GeneratorMaKind[] = ["sma", "ema", "wma"];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.floor(clamp(Number.isFinite(value) ? (value as number) : fallback, min, max));
}

export function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}
