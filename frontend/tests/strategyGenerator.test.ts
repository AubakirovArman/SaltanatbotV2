import { describe, expect, it } from "vitest";
import {
  GENERATOR_LIMITS,
  StrategyGenerationAbortedError,
  canonicalStrategyFingerprint,
  compileStrategyGenome,
  createGeneratorRandom,
  crossoverStrategyGenomes,
  generateStrategyCandidates,
  mutateStrategyGenome,
  resolveGeneratorConfig,
  validateGeneratedStrategy,
  type GeneratorProgress,
  type StrategyGenome
} from "../src/strategy/generator";
import type { StrategyIR } from "../src/strategy/ir";

const leftGenome: StrategyGenome = {
  direction: "long",
  signal: { family: "trend", variant: "ma-cross", maKind: "ema", fastPeriod: 9, slowPeriod: 21 },
  risk: { stopMode: "percent", stopValue: 9, targetMode: "percent", targetValue: 28, positionPct: 50 }
};

const rightGenome: StrategyGenome = {
  direction: "short",
  signal: { family: "momentum", variant: "roc", period: 14, threshold: 2 },
  risk: { stopMode: "atr", stopValue: 2, targetMode: "atr", targetValue: 4, positionPct: 25 }
};

describe("bounded strategy generator", () => {
  it("is reproducible for the same seed, including progress and provenance", async () => {
    const firstProgress: GeneratorProgress[] = [];
    const secondProgress: GeneratorProgress[] = [];
    const spec = { seed: 41, populationSize: 10, generations: 2, crossoverRate: 0.8, mutationRate: 0.6 };
    const first = await generateStrategyCandidates(spec, { onProgress: (progress) => firstProgress.push(progress) });
    const second = await generateStrategyCandidates(spec, { onProgress: (progress) => secondProgress.push(progress) });

    expect(second).toEqual(first);
    expect(secondProgress).toEqual(firstProgress);
    expect(first.candidates).toHaveLength(30);
    expect(firstProgress.at(-1)).toMatchObject({ accepted: 30, targetCandidates: 30, generation: 2 });
  });

  it("emits unique, bounded, structurally valid IR across many seeds", async () => {
    const observedFamilies = new Set<string>();
    const observedDirections = new Set<string>();
    for (let seed = 0; seed < 32; seed += 1) {
      const result = await generateStrategyCandidates({ seed, populationSize: 6, generations: 1 });
      const seen = new Set<string>();
      expect(result.exhausted).toBe(false);
      for (const candidate of result.candidates) {
        expect(candidate.validation.valid).toBe(true);
        expect(validateGeneratedStrategy(candidate.ir)).toEqual(candidate.validation);
        expect(seen.has(candidate.fingerprint)).toBe(false);
        expect(candidate.fingerprint).toBe(canonicalStrategyFingerprint(candidate.ir));
        expect(candidate.ir.inputs.length).toBeLessThanOrEqual(GENERATOR_LIMITS.maxIrInputs);
        for (const input of candidate.ir.inputs) {
          expect(Number.isFinite(input.value)).toBe(true);
          expect(input.value).toBeGreaterThanOrEqual(input.min ?? input.value);
          expect(input.value).toBeLessThanOrEqual(input.max ?? input.value);
        }
        for (const parent of candidate.provenance.parentFingerprints) expect(seen.has(parent)).toBe(true);
        if (candidate.provenance.origin === "mutation" || candidate.provenance.origin === "crossover-mutation") expect(candidate.provenance.mutationLog.length).toBeGreaterThan(0);
        observedFamilies.add(candidate.genome.signal.family);
        observedDirections.add(candidate.genome.direction);
        seen.add(candidate.fingerprint);
      }
    }
    expect(observedFamilies).toEqual(new Set(["trend", "mean-reversion", "breakout", "momentum"]));
    expect(observedDirections).toEqual(new Set(["long", "short"]));
  });

  it("honours family and direction filters", async () => {
    const result = await generateStrategyCandidates({ seed: 7, populationSize: 8, generations: 1, families: ["breakout"], directions: ["short"] });
    expect(result.candidates.every((candidate) => candidate.genome.signal.family === "breakout")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.genome.direction === "short")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.ir.body.some((statement) => statement.k === "entry" && statement.direction === "short"))).toBe(true);
  });

  it("performs bounded crossover and logged structural mutation", () => {
    const crossed = crossoverStrategyGenomes(leftGenome, rightGenome, createGeneratorRandom(2));
    const crossedValidation = validateGeneratedStrategy(compileStrategyGenome(crossed));
    expect(crossedValidation.valid).toBe(true);
    expect(crossed.risk.stopValue).toBeLessThanOrEqual(crossed.risk.stopMode === "atr" ? 6 : 10);
    expect(crossed.risk.targetValue).toBeLessThanOrEqual(crossed.risk.targetMode === "atr" ? 12 : 30);

    const mutation = mutateStrategyGenome(leftGenome, createGeneratorRandom(99), { rate: 1, ensureMutation: true });
    expect(mutation.mutationLog.length).toBeGreaterThan(0);
    expect(mutation.genome).not.toEqual(leftGenome);
    expect(validateGeneratedStrategy(compileStrategyGenome(mutation.genome)).valid).toBe(true);
  });

  it("canonicalizes object keys and semantically unordered inputs", () => {
    const ir = compileStrategyGenome(leftGenome);
    const reordered: StrategyIR = {
      v: ir.v,
      body: ir.body.map((statement) => ({ ...statement })),
      inputs: [...ir.inputs].reverse().map((input) => ({ step: input.step, max: input.max, min: input.min, value: input.value, name: input.name, defaultValue: input.defaultValue, optimizationEligible: input.optimizationEligible })),
      name: ir.name
    };
    expect(canonicalStrategyFingerprint(reordered)).toBe(canonicalStrategyFingerprint(ir));
  });

  it("clamps untrusted work sizes to a global candidate budget", () => {
    const config = resolveGeneratorConfig({ populationSize: Number.MAX_SAFE_INTEGER, generations: Number.MAX_SAFE_INTEGER, crossoverRate: 99, mutationRate: -2 });
    expect(config.populationSize).toBe(GENERATOR_LIMITS.maxPopulation);
    expect(config.generations).toBeLessThanOrEqual(GENERATOR_LIMITS.maxGenerations);
    expect(config.targetCandidates).toBeLessThanOrEqual(GENERATOR_LIMITS.maxCandidates);
    expect(config.crossoverRate).toBe(1);
    expect(config.mutationRate).toBe(0);
  });

  it("honours cancellation before and during cooperative generation", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(generateStrategyCandidates({ seed: 1 }, { signal: alreadyAborted.signal })).rejects.toBeInstanceOf(StrategyGenerationAbortedError);

    const running = new AbortController();
    let updates = 0;
    await expect(
      generateStrategyCandidates(
        { seed: 2, populationSize: 20, generations: 4 },
        {
          signal: running.signal,
          onProgress: () => {
            updates += 1;
            if (updates === 3) running.abort();
          }
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(updates).toBe(3);
  });
});
