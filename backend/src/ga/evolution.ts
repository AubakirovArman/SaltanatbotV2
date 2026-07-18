import {
  ALL_DIRECTIONS,
  ALL_FAMILIES,
  canonicalStrategyFingerprint,
  compileStrategyGenome,
  createGeneratorRandom,
  crossoverStrategyGenomes,
  GENERATOR_LIMITS,
  mutateStrategyGenome,
  pick,
  randomStrategyGenome,
  validateGeneratedStrategy,
  type GeneratorRandom,
  type MutationRecord,
  type StrategyGenome
} from "@saltanatbotv2/strategy-generator";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import { z } from "zod";

/**
 * Deterministic server-side GA generation engine (R9.2). All structural
 * variation goes through the PURE @saltanatbotv2/strategy-generator
 * primitives; this module only sequences them so that the complete PRNG state
 * is one serializable number (the Mulberry32 draw count) and a checkpointed
 * run resumes bit-for-bit where it stopped. Breeding rates intentionally pin
 * the package defaults: they are part of the reproducibility contract.
 */

export const GA_CHECKPOINT_SCHEMA_VERSION = "ga-checkpoint-v1";
export const GA_CROSSOVER_RATE = 0.75;
export const GA_MUTATION_RATE = 0.45;
/** Provenance version for ga_runs.generator_version; the package grammar engine identifier. */
export const GA_GENERATOR_VERSION = "bounded-grammar-v1";

export class GaEvolutionEngineError extends Error {}

/**
 * Mulberry32 wrapper that counts draws so the exact RNG state can live inside
 * a checkpoint. Restoring replays `draws` calls of the package generator —
 * cheap (bounded by the per-generation attempt limits) and provably identical
 * to never having stopped.
 */
export interface CountingRandom {
  random: GeneratorRandom;
  draws(): number;
}

export function createCountingRandom(seed: number, draws = 0): CountingRandom {
  const base = createGeneratorRandom(seed);
  for (let index = 0; index < draws; index += 1) base();
  let count = draws;
  return {
    random: () => {
      count += 1;
      return base();
    },
    draws: () => count
  };
}

export interface GaBreedingParent {
  fingerprint: string;
  genome: StrategyGenome;
}

export interface GaProducedCandidate {
  fingerprint: string;
  ir: StrategyIR;
  genome: StrategyGenome;
  origin: "seed" | "mutation" | "crossover" | "crossover-mutation";
  parentFingerprints: string[];
  mutationLog: MutationRecord[];
}

export interface GaGenerationOutcome {
  produced: GaProducedCandidate[];
  attempts: number;
  duplicates: number;
}

/**
 * Produce one generation of NEW unique candidates. With an empty parent pool
 * this seeds random genomes; otherwise it breeds from the pool exactly like
 * the package evolution loop (crossover, then optional guaranteed mutation).
 * `registry` holds every fingerprint the run has already evaluated and is
 * extended in place — a repeated genome counts as a duplicate attempt and is
 * NEVER handed back for re-evaluation.
 */
export function produceGeneration(input: {
  random: GeneratorRandom;
  populationSize: number;
  parents: readonly GaBreedingParent[];
  registry: Set<string>;
}): GaGenerationOutcome {
  const produced: GaProducedCandidate[] = [];
  let attempts = 0;
  let duplicates = 0;
  const attemptLimit = generationAttemptLimit(input.populationSize);
  for (let attempt = 0; produced.length < input.populationSize && attempt < attemptLimit; attempt += 1) {
    attempts += 1;
    const candidate = input.parents.length === 0 ? seedCandidate(input.random) : breedCandidate(input.parents, input.random);
    if (input.registry.has(candidate.fingerprint)) {
      duplicates += 1;
      continue;
    }
    input.registry.add(candidate.fingerprint);
    produced.push(candidate);
  }
  return { produced, attempts, duplicates };
}

function seedCandidate(random: GeneratorRandom): GaProducedCandidate {
  return buildCandidate(randomStrategyGenome(random, ALL_FAMILIES, ALL_DIRECTIONS), "seed", [], []);
}

/** Mirrors the package breedCandidate flow so provenance semantics stay identical. */
function breedCandidate(parents: readonly GaBreedingParent[], random: GeneratorRandom): GaProducedCandidate {
  const left = pick(parents, random);
  const cross = parents.length > 1 && random() < GA_CROSSOVER_RATE;
  const mutate = random() < GA_MUTATION_RATE;
  let genome: StrategyGenome;
  let parentFingerprints: string[];
  if (cross) {
    const alternatives = parents.filter((parent) => parent.fingerprint !== left.fingerprint);
    const right = pick(alternatives, random);
    genome = crossoverStrategyGenomes(left.genome, right.genome, random);
    parentFingerprints = [left.fingerprint, right.fingerprint];
  } else if (mutate) {
    genome = cloneGenome(left.genome);
    parentFingerprints = [left.fingerprint];
  } else {
    genome = randomStrategyGenome(random, ALL_FAMILIES, ALL_DIRECTIONS);
    parentFingerprints = [];
  }
  let mutationLog: MutationRecord[] = [];
  if (mutate) {
    const mutation = mutateStrategyGenome(genome, random, {
      rate: GA_MUTATION_RATE,
      families: ALL_FAMILIES,
      directions: ALL_DIRECTIONS,
      ensureMutation: true
    });
    genome = mutation.genome;
    mutationLog = mutation.mutationLog;
  }
  const origin = cross ? (mutationLog.length ? "crossover-mutation" : "crossover") : mutationLog.length ? "mutation" : "seed";
  return buildCandidate(genome, origin, parentFingerprints, mutationLog);
}

function buildCandidate(genome: StrategyGenome, origin: GaProducedCandidate["origin"], parentFingerprints: string[], mutationLog: MutationRecord[]): GaProducedCandidate {
  const ir = compileStrategyGenome(genome);
  const validation = validateGeneratedStrategy(ir);
  if (!validation.valid) throw new GaEvolutionEngineError(`Generator produced invalid StrategyIR: ${validation.issues.join(", ")}`);
  return { fingerprint: canonicalStrategyFingerprint(ir), ir, genome: cloneGenome(genome), origin, parentFingerprints, mutationLog };
}

function generationAttemptLimit(target: number): number {
  return Math.min(GENERATOR_LIMITS.maxAttemptsPerGeneration, Math.max(target, target * 64));
}

function cloneGenome(genome: StrategyGenome): StrategyGenome {
  return { direction: genome.direction, signal: { ...genome.signal }, risk: { ...genome.risk } };
}

// --- checkpoint codec: everything an exact resume needs, strictly validated ---

const boundedPeriod = z.number().finite();

const signalGenomeSchema = z.discriminatedUnion("variant", [
  z.object({ family: z.literal("trend"), variant: z.literal("ma-cross"), maKind: z.enum(["sma", "ema", "wma"]), fastPeriod: boundedPeriod, slowPeriod: boundedPeriod }).strict(),
  z.object({ family: z.literal("trend"), variant: z.literal("price-ma"), maKind: z.enum(["sma", "ema", "wma"]), period: boundedPeriod }).strict(),
  z.object({ family: z.literal("mean-reversion"), variant: z.literal("rsi-reentry"), period: boundedPeriod, trigger: boundedPeriod, exitLevel: boundedPeriod }).strict(),
  z.object({ family: z.literal("mean-reversion"), variant: z.literal("bollinger-fade"), period: boundedPeriod, deviation: boundedPeriod }).strict(),
  z.object({ family: z.literal("breakout"), variant: z.literal("donchian"), period: boundedPeriod, exitPeriod: boundedPeriod }).strict(),
  z.object({ family: z.literal("breakout"), variant: z.literal("bollinger-break"), period: boundedPeriod, deviation: boundedPeriod }).strict(),
  z.object({ family: z.literal("momentum"), variant: z.literal("roc"), period: boundedPeriod, threshold: boundedPeriod }).strict(),
  z.object({ family: z.literal("momentum"), variant: z.literal("macd"), fastPeriod: boundedPeriod, slowPeriod: boundedPeriod, signalPeriod: boundedPeriod }).strict()
]);

const strategyGenomeSchema = z.object({
  direction: z.enum(["long", "short"]),
  signal: signalGenomeSchema,
  risk: z.object({
    stopMode: z.enum(["percent", "atr"]),
    stopValue: z.number().finite(),
    targetMode: z.enum(["percent", "atr"]),
    targetValue: z.number().finite(),
    positionPct: z.number().finite()
  }).strict()
}).strict();

/** Draw ceiling: 16 generations x 8192 attempts x a generous per-attempt draw budget. */
const GA_CHECKPOINT_MAX_RNG_DRAWS = 100_000_000;

export const gaCheckpointSchema = z.object({
  schemaVersion: z.literal(GA_CHECKPOINT_SCHEMA_VERSION),
  rngDraws: z.number().int().min(0).max(GA_CHECKPOINT_MAX_RNG_DRAWS),
  generationsCompleted: z.number().int().min(0).max(16),
  population: z.array(z.object({ fingerprint: z.string().min(1).max(96), genome: strategyGenomeSchema }).strict()).max(GENERATOR_LIMITS.maxPopulation),
  counts: z.object({
    attempts: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    evaluated: z.number().int().min(0)
  }).strict()
}).strict();

export type GaCheckpoint = z.infer<typeof gaCheckpointSchema>;

export function freshCheckpoint(): GaCheckpoint {
  return {
    schemaVersion: GA_CHECKPOINT_SCHEMA_VERSION,
    rngDraws: 0,
    generationsCompleted: 0,
    population: [],
    counts: { attempts: 0, duplicates: 0, evaluated: 0 }
  };
}

/**
 * Parse a stored checkpoint. Every restored genome is recompiled and its
 * fingerprint compared: a checkpoint that no longer reproduces its own
 * population must never silently continue (determinism gate).
 */
export function restoreCheckpoint(value: unknown): GaCheckpoint {
  const parsed = gaCheckpointSchema.safeParse(value);
  if (!parsed.success) throw new GaEvolutionEngineError("Stored GA checkpoint is invalid.");
  for (const member of parsed.data.population) {
    if (canonicalStrategyFingerprint(compileStrategyGenome(member.genome)) !== member.fingerprint) {
      throw new GaEvolutionEngineError(`Stored GA checkpoint population does not reproduce fingerprint ${member.fingerprint}.`);
    }
  }
  return parsed.data;
}
