import { canonicalStrategyFingerprint, canonicalStrategyJson } from "./canonical.js";
import { compileStrategyGenome } from "./grammar.js";
import { crossoverStrategyGenomes, mutateStrategyGenome, randomStrategyGenome } from "./genome.js";
import { ALL_DIRECTIONS, ALL_FAMILIES, boundedInt, clamp, createGeneratorRandom, finiteOr, pick } from "./random.js";
import { GENERATOR_LIMITS } from "./types.js";
import { validateGeneratedStrategy } from "./validation.js";
const DEFAULT_SEED = 0x51a7e9d3;
const DEFAULT_POPULATION = 24;
const DEFAULT_GENERATIONS = 4;
const YIELD_BUDGET_MS = 40;
export class StrategyGenerationAbortedError extends Error {
    constructor() {
        super("Strategy generation aborted");
        this.name = "AbortError";
    }
}
/**
 * Generate bounded structural candidates only. Market data and candidate
 * evaluation deliberately remain outside this API.
 */
export async function generateStrategyCandidates(spec = {}, runtime = {}) {
    const config = resolveGeneratorConfig(spec);
    const random = createGeneratorRandom(config.seed);
    const candidates = [];
    const fingerprints = new Map();
    let attempts = 0;
    let duplicates = 0;
    let exhausted = false;
    let deadline = now() + YIELD_BUDGET_MS;
    assertNotAborted(runtime.signal);
    let population = [];
    const seedLimit = generationAttemptLimit(config.populationSize);
    for (let attempt = 0; population.length < config.populationSize && attempt < seedLimit; attempt += 1) {
        attempts += 1;
        assertNotAborted(runtime.signal);
        const candidate = buildCandidate(randomStrategyGenome(random, config.families, config.directions), {
            engine: "bounded-grammar-v1",
            seed: config.seed,
            generation: 0,
            origin: "seed",
            parentFingerprints: [],
            mutationLog: []
        });
        if (registerCandidate(candidate, fingerprints)) {
            population.push(candidate);
            candidates.push(candidate);
            report(runtime, progress("seed", 0, config, candidates.length, attempts, duplicates));
        }
        else {
            duplicates += 1;
        }
        deadline = await yieldWhenDue(deadline, runtime.signal);
    }
    if (population.length < config.populationSize)
        exhausted = true;
    for (let generation = 1; generation <= config.generations && candidates.length < config.targetCandidates; generation += 1) {
        assertNotAborted(runtime.signal);
        const nextPopulation = [];
        const target = Math.min(config.populationSize, config.targetCandidates - candidates.length);
        const attemptLimit = generationAttemptLimit(target);
        for (let attempt = 0; nextPopulation.length < target && attempt < attemptLimit; attempt += 1) {
            attempts += 1;
            const candidate = breedCandidate(population, generation, config, random);
            if (registerCandidate(candidate, fingerprints)) {
                nextPopulation.push(candidate);
                candidates.push(candidate);
                report(runtime, progress("evolve", generation, config, candidates.length, attempts, duplicates));
            }
            else {
                duplicates += 1;
            }
            assertNotAborted(runtime.signal);
            deadline = await yieldWhenDue(deadline, runtime.signal);
        }
        if (nextPopulation.length < target)
            exhausted = true;
        if (!nextPopulation.length)
            break;
        population = nextPopulation;
    }
    return { candidates, config, attempts, duplicates, exhausted };
}
export function resolveGeneratorConfig(spec = {}) {
    const families = allowedFamilies(spec.families);
    const directions = allowedDirections(spec.directions);
    const populationSize = boundedInt(spec.populationSize, DEFAULT_POPULATION, GENERATOR_LIMITS.minPopulation, GENERATOR_LIMITS.maxPopulation);
    const totalBoundedGenerations = Math.max(0, Math.floor(GENERATOR_LIMITS.maxCandidates / populationSize) - 1);
    const generations = boundedInt(spec.generations, DEFAULT_GENERATIONS, 0, Math.min(GENERATOR_LIMITS.maxGenerations, totalBoundedGenerations));
    return {
        seed: Number.isFinite(spec.seed) ? spec.seed >>> 0 : DEFAULT_SEED,
        populationSize,
        generations,
        families,
        directions,
        crossoverRate: clamp(finiteOr(spec.crossoverRate, 0.75), 0, 1),
        mutationRate: clamp(finiteOr(spec.mutationRate, 0.45), 0, 1),
        targetCandidates: populationSize * (generations + 1)
    };
}
function breedCandidate(population, generation, config, random) {
    const left = pick(population, random);
    const cross = population.length > 1 && random() < config.crossoverRate;
    const mutate = random() < config.mutationRate;
    let genome;
    let parents;
    if (cross) {
        const alternatives = population.filter((candidate) => candidate.fingerprint !== left.fingerprint);
        const right = pick(alternatives, random);
        genome = crossoverStrategyGenomes(left.genome, right.genome, random);
        parents = [left.fingerprint, right.fingerprint];
    }
    else if (mutate) {
        genome = cloneGenome(left.genome);
        parents = [left.fingerprint];
    }
    else {
        genome = randomStrategyGenome(random, config.families, config.directions);
        parents = [];
    }
    let mutationLog = [];
    if (mutate) {
        const mutation = mutateStrategyGenome(genome, random, {
            rate: config.mutationRate,
            families: config.families,
            directions: config.directions,
            ensureMutation: true
        });
        genome = mutation.genome;
        mutationLog = mutation.mutationLog;
    }
    const origin = cross ? (mutationLog.length ? "crossover-mutation" : "crossover") : mutationLog.length ? "mutation" : "seed";
    return buildCandidate(genome, {
        engine: "bounded-grammar-v1",
        seed: config.seed,
        generation,
        origin,
        parentFingerprints: parents,
        mutationLog
    });
}
function buildCandidate(genome, provenance) {
    const ir = compileStrategyGenome(genome);
    const validation = validateGeneratedStrategy(ir);
    if (!validation.valid)
        throw new Error(`Generator produced invalid StrategyIR: ${validation.issues.join(", ")}`);
    return {
        fingerprint: canonicalStrategyFingerprint(ir),
        ir,
        genome: cloneGenome(genome),
        provenance: { ...provenance, parentFingerprints: [...provenance.parentFingerprints], mutationLog: provenance.mutationLog.map((record) => ({ ...record })) },
        validation
    };
}
function registerCandidate(candidate, registry) {
    const canonical = canonicalStrategyJson(candidate.ir);
    const registered = registry.get(candidate.fingerprint);
    if (registered === canonical)
        return false;
    if (registered !== undefined)
        throw new Error(`Canonical strategy fingerprint collision: ${candidate.fingerprint}`);
    registry.set(candidate.fingerprint, canonical);
    return true;
}
function progress(phase, generation, config, accepted, attempts, duplicates) {
    return { phase, generation, generations: config.generations, accepted, targetCandidates: config.targetCandidates, attempts, duplicates };
}
function report(runtime, update) {
    runtime.onProgress?.(update);
    assertNotAborted(runtime.signal);
}
function generationAttemptLimit(target) {
    return Math.min(GENERATOR_LIMITS.maxAttemptsPerGeneration, Math.max(target, target * 64));
}
function allowedFamilies(requested) {
    const valid = new Set(ALL_FAMILIES);
    const selected = [...new Set((requested ?? ALL_FAMILIES).filter((family) => valid.has(family)))];
    return selected.length ? selected : [...ALL_FAMILIES];
}
function allowedDirections(requested) {
    const valid = new Set(ALL_DIRECTIONS);
    const selected = [...new Set((requested ?? ALL_DIRECTIONS).filter((direction) => valid.has(direction)))];
    return selected.length ? selected : [...ALL_DIRECTIONS];
}
function cloneGenome(genome) {
    return { direction: genome.direction, signal: { ...genome.signal }, risk: { ...genome.risk } };
}
function assertNotAborted(signal) {
    if (signal?.aborted)
        throw new StrategyGenerationAbortedError();
}
async function yieldWhenDue(deadline, signal) {
    if (now() < deadline)
        return deadline;
    const scheduler = globalThis.scheduler;
    if (typeof scheduler?.yield === "function")
        await scheduler.yield();
    else
        await new Promise((resolve) => setTimeout(resolve, 0));
    assertNotAborted(signal);
    return now() + YIELD_BUDGET_MS;
}
function now() {
    return globalThis.performance?.now() ?? Date.now();
}
