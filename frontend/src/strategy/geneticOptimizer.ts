import type { Candle } from "../types";
import { runBacktest, type BacktestConfig, type BacktestMetrics } from "./backtest";
import type { StrategyIR } from "./ir";
import { cloneWithInputs, type ParamCombo, type ParamSpec } from "./optimizer";
import type { SecurityDataContext } from "./securityData";
import { assertGeneticWindowWarmup } from "./geneticWarmup";

/**
 * Dependency-free genetic parameter search core. Inputs, progress snapshots and
 * results are structured-clone friendly so a module worker can own the compute.
 * Runtime-only callbacks and AbortSignal deliberately live outside the spec.
 */

export const GENETIC_LIMITS = {
  maxAxes: 32,
  minPopulation: 4,
  maxPopulation: 256,
  maxGenerations: 500,
  maxResults: 1_000,
  maxAllelesPerAxis: 10_000
} as const;

const DEFAULT_POPULATION = 48;
const DEFAULT_GENERATIONS = 30;
const DEFAULT_TRAIN_FRAC = 0.7;

export interface GeneticAxis {
  name: string;
  values: number[];
}

export interface GeneticFitnessPolicy {
  netProfitPctWeight: number;
  sharpeWeight: number;
  profitFactorWeight: number;
  returnOverDrawdownWeight: number;
  winRateWeight: number;
  drawdownPenalty: number;
  tradeShortfallPenalty: number;
  liquidationPenalty: number;
  generalizationGapPenalty: number;
  validationLossPenalty: number;
  minTradesPerWindow: number;
  trainWeight: number;
  validationWeight: number;
}

export const DEFAULT_GENETIC_FITNESS: Readonly<GeneticFitnessPolicy> = {
  netProfitPctWeight: 1,
  sharpeWeight: 8,
  profitFactorWeight: 4,
  returnOverDrawdownWeight: 8,
  winRateWeight: 0.5,
  drawdownPenalty: 1,
  tradeShortfallPenalty: 3,
  liquidationPenalty: 250,
  generalizationGapPenalty: 0.35,
  validationLossPenalty: 0.5,
  minTradesPerWindow: 3,
  trainWeight: 0.6,
  validationWeight: 0.4
};

export interface GeneticValidationSpec {
  minTrades?: number;
  minNetProfitPct?: number;
  maxDrawdownPct?: number;
}

export interface GeneticOptimizeSpec {
  params: ParamSpec[];
  seed?: number;
  populationSize?: number;
  generations?: number;
  trainFrac?: number;
  eliteCount?: number;
  tournamentSize?: number;
  crossoverRate?: number;
  mutationRate?: number;
  /** Largest local mutation jump as a fraction of an axis (0..1). */
  mutationSpan?: number;
  resultLimit?: number;
  fitness?: Partial<GeneticFitnessPolicy>;
  validation?: GeneticValidationSpec;
}

export interface WindowFitness {
  reward: number;
  penalty: number;
  score: number;
}

export interface GeneticFitness {
  train: WindowFitness;
  validation: WindowFitness;
  generalizationGapPenalty: number;
  validationLossPenalty: number;
  total: number;
}

export interface GeneticHoldoutValidation {
  passed: boolean;
  reasons: Array<"too-few-trades" | "negative-return" | "drawdown" | "liquidated">;
}

interface GeneticSearchCandidate {
  params: ParamCombo;
  canonicalKey: string;
  generationCreated: number;
  fitness: GeneticFitness;
  trainSample: BacktestMetrics;
  validationSample: BacktestMetrics;
}

export interface GeneticCandidateResult extends GeneticSearchCandidate {
  /** Only the preselected train/validation winner receives the final test audit. */
  testSample?: BacktestMetrics;
  holdout?: GeneticHoldoutValidation;
}

export interface GeneticHoldoutCandidateResult extends GeneticSearchCandidate {
  testSample: BacktestMetrics;
  holdout: GeneticHoldoutValidation;
}

export interface GeneticProgress {
  phase: "search" | "holdout";
  generation: number;
  generations: number;
  processed: number;
  total: number;
  uniqueEvaluated: number;
  cacheHits: number;
  populationSize: number;
  bestFitness?: number;
}

export interface GeneticRuntimeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: GeneticProgress) => void;
}

export interface ResolvedGeneticConfig {
  seed: number;
  populationSize: number;
  generations: number;
  trainFrac: number;
  eliteCount: number;
  tournamentSize: number;
  crossoverRate: number;
  mutationRate: number;
  mutationSpan: number;
  resultLimit: number;
  fitness: GeneticFitnessPolicy;
  validation: Required<GeneticValidationSpec>;
}

export interface GeneticOptimizeResult {
  ranked: GeneticCandidateResult[];
  best?: GeneticHoldoutCandidateResult;
  bestHoldoutPassed?: GeneticHoldoutCandidateResult;
  axes: GeneticAxis[];
  config: ResolvedGeneticConfig;
  trainEndIndex: number;
  validationEndIndex: number;
  trainBars: number;
  validationBars: number;
  testBars: number;
  requiredWarmupBars: number;
  holdoutEvaluated: number;
  searchSpaceSize: number;
  uniqueEvaluated: number;
  cacheHits: number;
  processed: number;
}

export class GeneticOptimizationAbortedError extends Error {
  constructor() {
    super("Genetic optimization aborted");
    this.name = "AbortError";
  }
}

export type GeneticRandom = () => number;

/** Mulberry32: fast, repeatable and independent of Math.random/clock state. */
export function createGeneticRandom(seed: number): GeneticRandom {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stable across object insertion order; used for population and evaluation dedupe. */
export function canonicalParamKey(params: ParamCombo): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((name) => [name, canonicalNumber(params[name])])
  );
}

/** Build finite, sorted alleles while enforcing both sweep and StrategyInput bounds. */
export function buildGeneticAxes(ir: StrategyIR, params: readonly ParamSpec[]): GeneticAxis[] {
  const inputs = new Map(ir.inputs.map((input) => [input.name, input]));
  const seen = new Set<string>();
  const axes: GeneticAxis[] = [];

  for (const parameter of params) {
    if (seen.has(parameter.name)) continue;
    const input = inputs.get(parameter.name);
    if (!input || input.optimizationEligible === false) continue;
    seen.add(parameter.name);

    const lower = Math.max(input.min ?? -Infinity, parameter.min ?? -Infinity);
    const upper = Math.min(input.max ?? Infinity, parameter.max ?? Infinity);
    let values: number[];
    if (parameter.values?.length) {
      values = parameter.values.filter((value) => Number.isFinite(value) && value >= lower && value <= upper);
    } else {
      const min = finiteOr(parameter.min, finiteOr(input.min, input.value));
      const max = finiteOr(parameter.max, finiteOr(input.max, min));
      const boundedMin = Math.max(min, input.min ?? min);
      const boundedMax = Math.min(max, input.max ?? max);
      if (boundedMax < boundedMin) continue;
      const step = positiveOr(parameter.step, positiveOr(input.step, 1));
      values = [];
      for (let index = 0, value = boundedMin; value <= boundedMax + 1e-9 && index < GENETIC_LIMITS.maxAllelesPerAxis; index += 1, value = boundedMin + index * step) {
        values.push(canonicalNumber(value));
      }
    }

    values = [...new Set(values.map(canonicalNumber))].sort((a, b) => a - b);
    if (values.length) axes.push({ name: parameter.name, values });
    if (axes.length === GENETIC_LIMITS.maxAxes) break;
  }
  return axes.sort((a, b) => compareText(a.name, b.name));
}

/** Uniform crossover; returns a new genome even when crossover is skipped. */
export function crossoverGenomes(left: ParamCombo, right: ParamCombo, axes: readonly GeneticAxis[], random: GeneticRandom, crossoverRate: number): ParamCombo {
  const cross = random() < clamp(crossoverRate, 0, 1);
  const child: ParamCombo = {};
  for (const axis of axes) child[axis.name] = cross && random() < 0.5 ? right[axis.name] : left[axis.name];
  return child;
}

/** Local bounded mutation. A rate of 1 changes every non-degenerate gene. */
export function mutateGenome(genome: ParamCombo, axes: readonly GeneticAxis[], random: GeneticRandom, mutationRate: number, mutationSpan = 0.2): ParamCombo {
  const child: ParamCombo = { ...genome };
  const rate = clamp(mutationRate, 0, 1);
  const span = clamp(mutationSpan, 0, 1);
  for (const axis of axes) {
    if (axis.values.length < 2 || random() >= rate) continue;
    const current = nearestAlleleIndex(axis.values, child[axis.name]);
    const maxJump = Math.max(1, Math.ceil((axis.values.length - 1) * span));
    const magnitude = 1 + Math.floor(random() * maxJump);
    const preferredDirection = random() < 0.5 ? -1 : 1;
    let next = current + preferredDirection * magnitude;
    if (next < 0 || next >= axis.values.length) next = current - preferredDirection * magnitude;
    next = Math.max(0, Math.min(axis.values.length - 1, next));
    if (next === current) next = current === 0 ? 1 : current - 1;
    child[axis.name] = axis.values[next];
  }
  return child;
}

export function scoreGeneticFitness(train: BacktestMetrics, validation: BacktestMetrics, policy: GeneticFitnessPolicy): GeneticFitness {
  const trainFitness = scoreWindow(train, policy);
  const validationFitness = scoreWindow(validation, policy);
  const weightSum = Math.max(1e-9, policy.trainWeight + policy.validationWeight);
  const generalizationGapPenalty = Math.abs(train.netProfitPct - validation.netProfitPct) * Math.max(0, policy.generalizationGapPenalty);
  const validationLossPenalty = Math.max(0, -validation.netProfitPct) * Math.max(0, policy.validationLossPenalty);
  const weighted = (trainFitness.score * policy.trainWeight + validationFitness.score * policy.validationWeight) / weightSum;
  return {
    train: trainFitness,
    validation: validationFitness,
    generalizationGapPenalty,
    validationLossPenalty,
    total: finiteScore(weighted - generalizationGapPenalty - validationLossPenalty)
  };
}

export function optimizeGenetic(ir: StrategyIR, candles: Candle[], backtestConfig: BacktestConfig, spec: GeneticOptimizeSpec, runtime: GeneticRuntimeOptions = {}, securityData?: SecurityDataContext): GeneticOptimizeResult {
  assertNotAborted(runtime.signal);
  if (candles.length < 6) throw new Error("Genetic optimization requires at least six candles for train, validation and test windows");
  const axes = buildGeneticAxes(ir, spec.params);
  if (!axes.length) throw new Error("Genetic optimization requires at least one bounded strategy input");

  const searchSpaceSize = calculateSearchSpaceSize(axes);
  const requestedPopulation = boundedInt(spec.populationSize, DEFAULT_POPULATION, GENETIC_LIMITS.minPopulation, GENETIC_LIMITS.maxPopulation);
  const populationSize = Math.max(1, Math.min(requestedPopulation, searchSpaceSize));
  const generations = boundedInt(spec.generations, DEFAULT_GENERATIONS, 1, GENETIC_LIMITS.maxGenerations);
  const config = resolveConfig(spec, axes, populationSize, generations);
  const random = createGeneticRandom(config.seed);
  const trainEndIndex = Math.max(2, Math.min(candles.length - 4, Math.floor(candles.length * config.trainFrac)));
  const remainingBars = candles.length - trainEndIndex;
  const validationEndIndex = trainEndIndex + Math.floor(remainingBars / 2);
  const train = candles.slice(0, trainEndIndex);
  const validation = candles.slice(trainEndIndex, validationEndIndex);
  const test = candles.slice(validationEndIndex);
  const windows = [
    ["train", train],
    ["validation", validation],
    ["test", test]
  ] as const;
  let requiredWarmupBars = 0;
  const cache = new Map<string, GeneticSearchCandidate>();
  let cacheHits = 0;
  let processed = 0;
  let population = initialPopulation(ir, axes, populationSize, searchSpaceSize, random);
  const total = populationSize * generations + 1;

  for (let generation = 0; generation < generations; generation += 1) {
    assertNotAborted(runtime.signal);
    const evaluated: GeneticSearchCandidate[] = [];
    let bestInGeneration: GeneticSearchCandidate | undefined;
    for (const genome of population) {
      assertNotAborted(runtime.signal);
      const key = canonicalParamKey(genome);
      let candidate = cache.get(key);
      if (candidate) {
        cacheHits += 1;
      } else {
        const strategy = cloneWithInputs(ir, genome);
        requiredWarmupBars = Math.max(requiredWarmupBars, assertGeneticWindowWarmup(strategy, windows));
        const trainRun = runBacktest(strategy, train, backtestConfig, securityData);
        assertNotAborted(runtime.signal);
        const validationRun = runBacktest(strategy, validation, backtestConfig, securityData);
        const fitness = scoreGeneticFitness(trainRun.metrics, validationRun.metrics, config.fitness);
        candidate = {
          params: { ...genome },
          canonicalKey: key,
          generationCreated: generation,
          fitness,
          trainSample: trainRun.metrics,
          validationSample: validationRun.metrics
        };
        cache.set(key, candidate);
      }
      evaluated.push(candidate);
      if (!bestInGeneration || compareCandidates(candidate, bestInGeneration) < 0) bestInGeneration = candidate;
      processed += 1;
      runtime.onProgress?.({
        phase: "search",
        generation: generation + 1,
        generations,
        processed,
        total,
        uniqueEvaluated: cache.size,
        cacheHits,
        populationSize,
        bestFitness: bestInGeneration?.fitness.total
      });
      assertNotAborted(runtime.signal);
    }

    evaluated.sort(compareCandidates);
    if (generation < generations - 1) {
      population = breedPopulation(evaluated, axes, config, populationSize, searchSpaceSize, random);
    }
  }

  const searchRanked = [...cache.values()].sort(compareCandidates).slice(0, config.resultLimit);
  const selected = searchRanked[0]!;
  runtime.onProgress?.({
    phase: "holdout",
    generation: generations,
    generations,
    processed,
    total,
    uniqueEvaluated: cache.size,
    cacheHits,
    populationSize,
    bestFitness: selected.fitness.total
  });
  assertNotAborted(runtime.signal);
  const testSample = runBacktest(cloneWithInputs(ir, selected.params), test, backtestConfig, securityData).metrics;
  const best: GeneticHoldoutCandidateResult = { ...selected, testSample, holdout: validateHoldout(testSample, config.validation) };
  processed += 1;
  runtime.onProgress?.({
    phase: "holdout",
    generation: generations,
    generations,
    processed,
    total,
    uniqueEvaluated: cache.size,
    cacheHits,
    populationSize,
    bestFitness: selected.fitness.total
  });
  const ranked: GeneticCandidateResult[] = [best, ...searchRanked.slice(1)];
  return {
    ranked,
    best,
    bestHoldoutPassed: best.holdout.passed ? best : undefined,
    axes,
    config,
    trainEndIndex,
    validationEndIndex,
    trainBars: train.length,
    validationBars: validation.length,
    testBars: test.length,
    requiredWarmupBars,
    holdoutEvaluated: 1,
    searchSpaceSize,
    uniqueEvaluated: cache.size,
    cacheHits,
    processed
  };
}

function resolveConfig(spec: GeneticOptimizeSpec, axes: readonly GeneticAxis[], populationSize: number, generations: number): ResolvedGeneticConfig {
  const defaultElite = Math.max(1, Math.floor(populationSize * 0.1));
  const eliteCount = populationSize <= 1 ? 1 : boundedInt(spec.eliteCount, defaultElite, 1, populationSize - 1);
  const policy = { ...DEFAULT_GENETIC_FITNESS, ...finitePolicy(spec.fitness) };
  policy.minTradesPerWindow = boundedInt(policy.minTradesPerWindow, 3, 0, 1_000_000);
  policy.trainWeight = Math.max(0, policy.trainWeight);
  policy.validationWeight = Math.max(0, policy.validationWeight);
  if (policy.trainWeight + policy.validationWeight === 0) policy.trainWeight = 1;
  return {
    seed: Number.isFinite(spec.seed) ? (spec.seed as number) >>> 0 : deriveSeed(axes),
    populationSize,
    generations,
    trainFrac: clamp(finiteOr(spec.trainFrac, DEFAULT_TRAIN_FRAC), 0.1, 0.9),
    eliteCount,
    tournamentSize: boundedInt(spec.tournamentSize, 3, 1, populationSize),
    crossoverRate: clamp(finiteOr(spec.crossoverRate, 0.85), 0, 1),
    mutationRate: clamp(finiteOr(spec.mutationRate, 0.15), 0, 1),
    mutationSpan: clamp(finiteOr(spec.mutationSpan, 0.2), 0, 1),
    resultLimit: boundedInt(spec.resultLimit, 100, 1, GENETIC_LIMITS.maxResults),
    fitness: policy,
    validation: {
      minTrades: boundedInt(spec.validation?.minTrades, policy.minTradesPerWindow, 0, 1_000_000),
      minNetProfitPct: finiteOr(spec.validation?.minNetProfitPct, 0),
      maxDrawdownPct: Math.max(0, finiteOr(spec.validation?.maxDrawdownPct, 30))
    }
  };
}

function initialPopulation(ir: StrategyIR, axes: readonly GeneticAxis[], populationSize: number, searchSpaceSize: number, random: GeneticRandom): ParamCombo[] {
  const unique = new Map<string, ParamCombo>();
  const inputs = new Map(ir.inputs.map((input) => [input.name, input.value]));
  const baseline: ParamCombo = {};
  for (const axis of axes) baseline[axis.name] = axis.values[nearestAlleleIndex(axis.values, inputs.get(axis.name) ?? axis.values[0])];
  unique.set(canonicalParamKey(baseline), baseline);

  const attempts = populationSize * 100;
  for (let attempt = 0; unique.size < populationSize && attempt < attempts; attempt += 1) {
    const genome: ParamCombo = {};
    for (const axis of axes) genome[axis.name] = axis.values[Math.floor(random() * axis.values.length)];
    unique.set(canonicalParamKey(genome), genome);
  }
  for (let index = 0; unique.size < populationSize && index < searchSpaceSize; index += 1) {
    const genome = genomeAtIndex(index, axes);
    unique.set(canonicalParamKey(genome), genome);
  }
  return [...unique.values()];
}

function breedPopulation(ranked: readonly GeneticSearchCandidate[], axes: readonly GeneticAxis[], config: ResolvedGeneticConfig, targetSize: number, searchSpaceSize: number, random: GeneticRandom): ParamCombo[] {
  const next = new Map<string, ParamCombo>();
  for (const elite of ranked.slice(0, config.eliteCount)) next.set(elite.canonicalKey, { ...elite.params });

  for (let attempt = 0; next.size < targetSize && attempt < targetSize * 100; attempt += 1) {
    const left = tournamentSelect(ranked, config.tournamentSize, random).params;
    const right = tournamentSelect(ranked, config.tournamentSize, random).params;
    const crossed = crossoverGenomes(left, right, axes, random, config.crossoverRate);
    const child = mutateGenome(crossed, axes, random, config.mutationRate, config.mutationSpan);
    next.set(canonicalParamKey(child), child);
  }
  for (let index = 0; next.size < targetSize && index < searchSpaceSize; index += 1) {
    const immigrant = genomeAtIndex(index, axes);
    next.set(canonicalParamKey(immigrant), immigrant);
  }
  return [...next.values()];
}

function tournamentSelect(ranked: readonly GeneticSearchCandidate[], tournamentSize: number, random: GeneticRandom): GeneticSearchCandidate {
  let winner = ranked[Math.floor(random() * ranked.length)];
  for (let draw = 1; draw < tournamentSize; draw += 1) {
    const candidate = ranked[Math.floor(random() * ranked.length)];
    if (compareCandidates(candidate, winner) < 0) winner = candidate;
  }
  return winner;
}

function scoreWindow(metrics: BacktestMetrics, policy: GeneticFitnessPolicy): WindowFitness {
  const profitFactor = Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : metrics.netProfit > 0 ? 5 : 0;
  const reward =
    finiteScore(metrics.netProfitPct) * policy.netProfitPctWeight +
    clamp(finiteScore(metrics.sharpe), -5, 5) * policy.sharpeWeight +
    clamp(profitFactor - 1, -1, 4) * policy.profitFactorWeight +
    clamp(metrics.netProfitPct / Math.max(1, metrics.maxDrawdownPct), -20, 20) * policy.returnOverDrawdownWeight +
    clamp((metrics.winRate - 50) / 10, -5, 5) * policy.winRateWeight;
  const penalty = Math.max(0, metrics.maxDrawdownPct) * Math.max(0, policy.drawdownPenalty) + Math.max(0, policy.minTradesPerWindow - metrics.totalTrades) * Math.max(0, policy.tradeShortfallPenalty) + (metrics.liquidated ? Math.max(0, policy.liquidationPenalty) : 0);
  return { reward: finiteScore(reward), penalty: finiteScore(penalty), score: finiteScore(reward - penalty) };
}

function validateHoldout(metrics: BacktestMetrics, validation: Required<GeneticValidationSpec>): GeneticHoldoutValidation {
  const reasons: GeneticHoldoutValidation["reasons"] = [];
  if (metrics.totalTrades < validation.minTrades) reasons.push("too-few-trades");
  if (metrics.netProfitPct < validation.minNetProfitPct) reasons.push("negative-return");
  if (metrics.maxDrawdownPct > validation.maxDrawdownPct) reasons.push("drawdown");
  if (metrics.liquidated) reasons.push("liquidated");
  return { passed: reasons.length === 0, reasons };
}

function compareCandidates(left: GeneticSearchCandidate, right: GeneticSearchCandidate): number {
  return right.fitness.total - left.fitness.total || compareText(left.canonicalKey, right.canonicalKey);
}

function genomeAtIndex(index: number, axes: readonly GeneticAxis[]): ParamCombo {
  const genome: ParamCombo = {};
  let cursor = index;
  for (const axis of axes) {
    genome[axis.name] = axis.values[cursor % axis.values.length];
    cursor = Math.floor(cursor / axis.values.length);
  }
  return genome;
}

function calculateSearchSpaceSize(axes: readonly GeneticAxis[]): number {
  let total = 1;
  for (const axis of axes) {
    if (total > Number.MAX_SAFE_INTEGER / axis.values.length) return Number.MAX_SAFE_INTEGER;
    total *= axis.values.length;
  }
  return total;
}

function nearestAlleleIndex(values: readonly number[], value: number): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - value) < Math.abs(values[best] - value)) best = index;
  }
  return best;
}

function deriveSeed(axes: readonly GeneticAxis[]): number {
  let hash = 0x811c9dc5;
  for (const axis of axes) {
    const text = `${axis.name}:${axis.values.join(",")};`;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function finitePolicy(policy: Partial<GeneticFitnessPolicy> | undefined): Partial<GeneticFitnessPolicy> {
  if (!policy) return {};
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => Number.isFinite(value))) as Partial<GeneticFitnessPolicy>;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(finiteOr(value, fallback))));
}

function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Genetic parameter values must be finite");
  return Object.is(value, -0) ? 0 : Number.parseFloat(value.toPrecision(12));
}

function finiteScore(value: number): number {
  if (Number.isNaN(value)) return -1e12;
  if (value === Infinity) return 1e12;
  if (value === -Infinity) return -1e12;
  return clamp(value, -1e12, 1e12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GeneticOptimizationAbortedError();
}
