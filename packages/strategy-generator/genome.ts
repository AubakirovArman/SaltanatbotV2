import { ALL_DIRECTIONS, ALL_FAMILIES, ALL_MA_KINDS, canonicalNumber, clamp, pick, randomDecimal, randomInt } from "./random.js";
import type { GeneratorRandom } from "./random.js";
import { GENERATOR_LIMITS, type MutationRecord, type RiskGenome, type SignalGenome, type StrategyFamily, type StrategyGenome, type TradeDirection } from "./types.js";

export interface MutationOptions {
  rate: number;
  families?: readonly StrategyFamily[];
  directions?: readonly TradeDirection[];
  ensureMutation?: boolean;
}

export function randomStrategyGenome(random: GeneratorRandom, families: readonly StrategyFamily[] = ALL_FAMILIES, directions: readonly TradeDirection[] = ALL_DIRECTIONS): StrategyGenome {
  return {
    direction: pick(directions, random),
    signal: randomSignal(random, families),
    risk: randomRisk(random)
  };
}

export function randomSignal(random: GeneratorRandom, families: readonly StrategyFamily[] = ALL_FAMILIES): SignalGenome {
  const family = pick(families, random);
  if (family === "trend") {
    if (random() < 0.5) {
      const fastPeriod = randomInt(random, 3, 60);
      return { family, variant: "ma-cross", maKind: pick(ALL_MA_KINDS, random), fastPeriod, slowPeriod: randomInt(random, fastPeriod + 3, 250) };
    }
    return { family, variant: "price-ma", maKind: pick(ALL_MA_KINDS, random), period: randomInt(random, 5, 250) };
  }
  if (family === "mean-reversion") {
    if (random() < 0.5) return { family, variant: "rsi-reentry", period: randomInt(random, 5, 50), trigger: randomInt(random, 20, 40), exitLevel: randomInt(random, 50, 75) };
    return { family, variant: "bollinger-fade", period: randomInt(random, 10, 100), deviation: randomDecimal(random, 1, 4, 0.25) };
  }
  if (family === "breakout") {
    if (random() < 0.5) return { family, variant: "donchian", period: randomInt(random, 10, 250), exitPeriod: randomInt(random, 3, 100) };
    return { family, variant: "bollinger-break", period: randomInt(random, 10, 100), deviation: randomDecimal(random, 1, 4, 0.25) };
  }
  if (random() < 0.5) return { family, variant: "roc", period: randomInt(random, 2, 100), threshold: randomDecimal(random, 0.25, 10, 0.25) };
  const fastPeriod = randomInt(random, 3, 24);
  return { family, variant: "macd", fastPeriod, slowPeriod: randomInt(random, Math.max(20, fastPeriod + 3), 80), signalPeriod: randomInt(random, 2, 30) };
}

export function crossoverStrategyGenomes(left: StrategyGenome, right: StrategyGenome, random: GeneratorRandom): StrategyGenome {
  const child: StrategyGenome = {
    direction: random() < 0.5 ? left.direction : right.direction,
    signal: { ...(random() < 0.5 ? left.signal : right.signal) },
    risk: {
      stopMode: random() < 0.5 ? left.risk.stopMode : right.risk.stopMode,
      stopValue: random() < 0.5 ? left.risk.stopValue : right.risk.stopValue,
      targetMode: random() < 0.5 ? left.risk.targetMode : right.risk.targetMode,
      targetValue: random() < 0.5 ? left.risk.targetValue : right.risk.targetValue,
      positionPct: random() < 0.5 ? left.risk.positionPct : right.risk.positionPct
    }
  };
  child.risk.stopValue = clampRiskValue(child.risk.stopValue, child.risk.stopMode, "stop");
  child.risk.targetValue = clampRiskValue(child.risk.targetValue, child.risk.targetMode, "target");
  return child;
}

export function mutateStrategyGenome(genome: StrategyGenome, random: GeneratorRandom, options: MutationOptions): { genome: StrategyGenome; mutationLog: MutationRecord[] } {
  const next: StrategyGenome = { direction: genome.direction, signal: { ...genome.signal }, risk: { ...genome.risk } };
  const log: MutationRecord[] = [];
  const rate = clamp(options.rate, 0, 1);
  const families = options.families?.length ? options.families : ALL_FAMILIES;
  const directions = options.directions?.length ? options.directions : ALL_DIRECTIONS;

  if (random() < rate) mutateDirection(next, directions, random, log);
  if (random() < rate) mutateSignal(next, families, random, log);
  if (random() < rate) mutateRisk(next, random, log);
  if (!log.length && options.ensureMutation !== false) {
    const mutation = randomInt(random, 0, 2);
    if (mutation === 0) mutateSignal(next, families, random, log);
    else if (mutation === 1) mutateRisk(next, random, log);
    else mutateDirection(next, directions, random, log);
    if (!log.length) mutateRisk(next, random, log);
  }
  return { genome: next, mutationLog: log.slice(0, GENERATOR_LIMITS.maxMutationLogEntries) };
}

function randomRisk(random: GeneratorRandom): RiskGenome {
  const stopMode = random() < 0.5 ? "percent" : "atr";
  const targetMode = random() < 0.5 ? "percent" : "atr";
  return {
    stopMode,
    stopValue: randomRiskValue(random, stopMode, "stop"),
    targetMode,
    targetValue: randomRiskValue(random, targetMode, "target"),
    positionPct: randomInt(random, 5, 100, 5)
  };
}

function mutateDirection(next: StrategyGenome, directions: readonly TradeDirection[], random: GeneratorRandom, log: MutationRecord[]): void {
  const alternatives = directions.filter((direction) => direction !== next.direction);
  if (!alternatives.length) return;
  const from = next.direction;
  next.direction = pick(alternatives, random);
  record(log, "replace", "direction", from, next.direction);
}

function mutateSignal(next: StrategyGenome, families: readonly StrategyFamily[], random: GeneratorRandom, log: MutationRecord[]): void {
  if (random() < 0.4) {
    const from = signalSummary(next.signal);
    let replacement = randomSignal(random, families);
    for (let attempt = 0; attempt < 8 && signalSummary(replacement) === from; attempt += 1) replacement = randomSignal(random, families);
    next.signal = replacement;
    record(log, "replace", "signal", from, signalSummary(replacement));
    return;
  }
  next.signal = mutateSignalParameter(next.signal, random, log);
}

function mutateSignalParameter(signal: SignalGenome, random: GeneratorRandom, log: MutationRecord[]): SignalGenome {
  const next = { ...signal } as SignalGenome;
  if (next.variant === "ma-cross") {
    const field = pick(["maKind", "fastPeriod", "slowPeriod"] as const, random);
    if (field === "maKind") replaceMaKind(next, random, log);
    else if (field === "fastPeriod") replaceNumber(next, field, randomDifferentInt(random, next.fastPeriod, 3, Math.min(60, next.slowPeriod - 3)), log);
    else replaceNumber(next, field, randomDifferentInt(random, next.slowPeriod, next.fastPeriod + 3, 250), log);
  } else if (next.variant === "price-ma") {
    if (random() < 0.35) replaceMaKind(next, random, log);
    else replaceNumber(next, "period", randomDifferentInt(random, next.period, 5, 250), log);
  } else if (next.variant === "rsi-reentry") {
    const field = pick(["period", "trigger", "exitLevel"] as const, random);
    const range = field === "period" ? [5, 50] : field === "trigger" ? [20, 40] : [50, 75];
    replaceNumber(next, field, randomDifferentInt(random, next[field], range[0], range[1]), log);
  } else if (next.variant === "bollinger-fade" || next.variant === "bollinger-break") {
    if (random() < 0.5) replaceNumber(next, "period", randomDifferentInt(random, next.period, 10, 100), log);
    else replaceNumber(next, "deviation", randomDifferentDecimal(random, next.deviation, 1, 4, 0.25), log);
  } else if (next.variant === "donchian") {
    const field = random() < 0.5 ? "period" : "exitPeriod";
    replaceNumber(next, field, randomDifferentInt(random, next[field], field === "period" ? 10 : 3, field === "period" ? 250 : 100), log);
  } else if (next.variant === "roc") {
    if (random() < 0.5) replaceNumber(next, "period", randomDifferentInt(random, next.period, 2, 100), log);
    else replaceNumber(next, "threshold", randomDifferentDecimal(random, next.threshold, 0.25, 10, 0.25), log);
  } else {
    const field = pick(["fastPeriod", "slowPeriod", "signalPeriod"] as const, random);
    if (field === "fastPeriod") replaceNumber(next, field, randomDifferentInt(random, next.fastPeriod, 3, Math.min(24, next.slowPeriod - 3)), log);
    else if (field === "slowPeriod") replaceNumber(next, field, randomDifferentInt(random, next.slowPeriod, Math.max(20, next.fastPeriod + 3), 80), log);
    else replaceNumber(next, field, randomDifferentInt(random, next.signalPeriod, 2, 30), log);
  }
  return next;
}

function mutateRisk(next: StrategyGenome, random: GeneratorRandom, log: MutationRecord[]): void {
  const field = pick(["stopMode", "stopValue", "targetMode", "targetValue", "positionPct"] as const, random);
  if (field === "stopMode") {
    const from = next.risk.stopMode;
    next.risk.stopMode = from === "percent" ? "atr" : "percent";
    record(log, "replace", "risk.stopMode", from, next.risk.stopMode);
    const value = next.risk.stopValue;
    next.risk.stopValue = clampRiskValue(value, next.risk.stopMode, "stop");
    if (value !== next.risk.stopValue) record(log, "bounded-step", "risk.stopValue", value, next.risk.stopValue);
  } else if (field === "targetMode") {
    const from = next.risk.targetMode;
    next.risk.targetMode = from === "percent" ? "atr" : "percent";
    record(log, "replace", "risk.targetMode", from, next.risk.targetMode);
    const value = next.risk.targetValue;
    next.risk.targetValue = clampRiskValue(value, next.risk.targetMode, "target");
    if (value !== next.risk.targetValue) record(log, "bounded-step", "risk.targetValue", value, next.risk.targetValue);
  } else if (field === "stopValue") {
    replaceNumber(next.risk, field, randomDifferentRiskValue(random, next.risk.stopValue, next.risk.stopMode, "stop"), log, "risk.stopValue");
  } else if (field === "targetValue") {
    replaceNumber(next.risk, field, randomDifferentRiskValue(random, next.risk.targetValue, next.risk.targetMode, "target"), log, "risk.targetValue");
  } else {
    replaceNumber(next.risk, field, randomDifferentInt(random, next.risk.positionPct, 5, 100, 5), log, "risk.positionPct");
  }
}

function replaceMaKind(signal: Extract<SignalGenome, { family: "trend" }>, random: GeneratorRandom, log: MutationRecord[]): void {
  const from = signal.maKind;
  signal.maKind = pick(
    ALL_MA_KINDS.filter((kind) => kind !== from),
    random
  );
  record(log, "replace", "signal.maKind", from, signal.maKind);
}

function replaceNumber<T extends object, K extends keyof T>(target: T, field: K, value: number, log: MutationRecord[], path = `signal.${String(field)}`): void {
  const from = target[field] as number;
  target[field] = value as T[K];
  record(log, "bounded-step", path, from, value);
}

function randomDifferentInt(random: GeneratorRandom, current: number, min: number, max: number, step = 1): number {
  if (max <= min) return min;
  let value = current;
  for (let attempt = 0; attempt < 8 && value === current; attempt += 1) value = randomInt(random, min, max, step);
  if (value === current) value = current + step <= max ? current + step : Math.max(min, current - step);
  return value;
}

function randomDifferentDecimal(random: GeneratorRandom, current: number, min: number, max: number, step: number): number {
  if (max <= min) return min;
  let value = current;
  for (let attempt = 0; attempt < 8 && value === current; attempt += 1) value = randomDecimal(random, min, max, step);
  if (value === current) value = canonicalNumber(current + step <= max ? current + step : Math.max(min, current - step));
  return value;
}

function randomRiskValue(random: GeneratorRandom, mode: RiskGenome["stopMode"], kind: "stop" | "target"): number {
  const [min, max, step] = riskRange(mode, kind);
  return randomDecimal(random, min, max, step);
}

function randomDifferentRiskValue(random: GeneratorRandom, current: number, mode: RiskGenome["stopMode"], kind: "stop" | "target"): number {
  const [min, max, step] = riskRange(mode, kind);
  return randomDifferentDecimal(random, current, min, max, step);
}

function clampRiskValue(value: number, mode: RiskGenome["stopMode"], kind: "stop" | "target"): number {
  const [min, max] = riskRange(mode, kind);
  return canonicalNumber(clamp(value, min, max));
}

function riskRange(mode: RiskGenome["stopMode"], kind: "stop" | "target"): [number, number, number] {
  if (kind === "stop") return mode === "percent" ? [0.5, 10, 0.25] : [0.5, 6, 0.25];
  return mode === "percent" ? [1, 30, 0.5] : [1, 12, 0.25];
}

function signalSummary(signal: SignalGenome): string {
  return JSON.stringify(signal);
}

function record(log: MutationRecord[], operator: MutationRecord["operator"], field: string, from: string | number, to: string | number): void {
  if (from !== to && log.length < GENERATOR_LIMITS.maxMutationLogEntries) log.push({ operator, field, from, to });
}
