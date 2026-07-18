import { describe, expect, it } from "vitest";
import { canonicalStrategyJson, compileStrategyGenome, createGeneratorRandom } from "@saltanatbotv2/strategy-generator";
import {
  createCountingRandom,
  freshCheckpoint,
  GA_CHECKPOINT_SCHEMA_VERSION,
  GaEvolutionEngineError,
  produceGeneration,
  restoreCheckpoint,
  type GaCheckpoint
} from "../src/ga/evolution.js";
import {
  buildOosReport,
  computeObjectiveVector,
  computeParetoRanks,
  GaObjectiveError,
  strategyComplexity,
  type GaMarketWindowMetrics,
  type GaObjectiveKey
} from "../src/ga/objectives.js";

/**
 * Pure GA engine seams (R9.2): the counting PRNG whose whole state is a draw
 * count, generation production with fingerprint dedup, the strict checkpoint
 * codec, and the deterministic Pareto/OOS mathematics. Everything here must be
 * exactly reproducible — the seeded-reproducibility release criterion builds
 * on these primitives.
 */

describe("counting random", () => {
  it("counts draws and fast-forwards to an identical stream (checkpoint = draw count)", () => {
    const full = createCountingRandom(1234);
    const first = Array.from({ length: 10 }, () => full.random());
    expect(full.draws()).toBe(10);

    // Restoring at draw 4 replays exactly the tail of the same stream.
    const resumed = createCountingRandom(1234, 4);
    expect(resumed.draws()).toBe(4);
    const tail = Array.from({ length: 6 }, () => resumed.random());
    expect(tail).toEqual(first.slice(4));
    expect(resumed.draws()).toBe(10);

    // The wrapper never diverges from the raw package generator.
    const raw = createGeneratorRandom(1234);
    expect(Array.from({ length: 10 }, () => raw())).toEqual(first);
  });
});

describe("generation production and dedup", () => {
  it("seeds identical unique generations for identical seeds", () => {
    const first = produceGeneration({ random: createCountingRandom(7).random, populationSize: 8, parents: [], registry: new Set() });
    const second = produceGeneration({ random: createCountingRandom(7).random, populationSize: 8, parents: [], registry: new Set() });
    expect(first.produced).toHaveLength(8);
    expect(first.produced.map((candidate) => candidate.fingerprint)).toEqual(second.produced.map((candidate) => candidate.fingerprint));
    expect(new Set(first.produced.map((candidate) => candidate.fingerprint)).size).toBe(8);
    expect(first.attempts).toBe(second.attempts);
    // Seed candidates carry provenance-complete (empty) lineage.
    for (const candidate of first.produced) {
      expect(candidate.origin).toBe("seed");
      expect(candidate.parentFingerprints).toEqual([]);
      expect(candidate.mutationLog).toEqual([]);
    }
  });

  it("never hands back an already-registered genome: replayed candidates count as duplicates", () => {
    const registry = new Set<string>();
    const original = produceGeneration({ random: createCountingRandom(7).random, populationSize: 8, parents: [], registry });
    const known = new Set(original.produced.map((candidate) => candidate.fingerprint));

    // A fresh RNG with the same seed re-generates the same candidates first —
    // every one of them must be skipped as a duplicate, never re-emitted.
    const replay = produceGeneration({ random: createCountingRandom(7).random, populationSize: 8, parents: [], registry });
    expect(replay.duplicates).toBeGreaterThanOrEqual(8);
    expect(replay.attempts).toBe(replay.produced.length + replay.duplicates);
    for (const candidate of replay.produced) {
      expect(known.has(candidate.fingerprint)).toBe(false);
    }
  });

  it("breeds deterministically from a parent pool and records crossover lineage", () => {
    const seedPool = produceGeneration({ random: createCountingRandom(11).random, populationSize: 8, parents: [], registry: new Set() });
    const parents = seedPool.produced.map((candidate) => ({ fingerprint: candidate.fingerprint, genome: candidate.genome }));
    const parentKeys = new Set(parents.map((parent) => parent.fingerprint));

    const rng = createCountingRandom(11, 1_000);
    const bredA = produceGeneration({ random: rng.random, populationSize: 8, parents, registry: new Set(parentKeys) });
    const rngB = createCountingRandom(11, 1_000);
    const bredB = produceGeneration({ random: rngB.random, populationSize: 8, parents, registry: new Set(parentKeys) });
    expect(bredA.produced.map((candidate) => candidate.fingerprint)).toEqual(bredB.produced.map((candidate) => candidate.fingerprint));
    expect(rng.draws()).toBe(rngB.draws());

    expect(bredA.produced.length).toBeGreaterThan(0);
    for (const candidate of bredA.produced) {
      expect(["seed", "mutation", "crossover", "crossover-mutation"]).toContain(candidate.origin);
      for (const parent of candidate.parentFingerprints) expect(parentKeys.has(parent)).toBe(true);
      if (candidate.origin === "crossover" || candidate.origin === "crossover-mutation") {
        expect(candidate.parentFingerprints).toHaveLength(2);
      }
      if (candidate.origin === "mutation" || candidate.origin === "crossover-mutation") {
        expect(candidate.mutationLog.length).toBeGreaterThan(0);
      }
    }
    expect(bredA.produced.some((candidate) => candidate.parentFingerprints.length === 2)).toBe(true);
  });
});

describe("checkpoint codec", () => {
  it("round-trips a fresh checkpoint and a populated one", () => {
    expect(restoreCheckpoint(freshCheckpoint())).toEqual(freshCheckpoint());

    const generation = produceGeneration({ random: createCountingRandom(21).random, populationSize: 8, parents: [], registry: new Set() });
    const checkpoint: GaCheckpoint = {
      schemaVersion: GA_CHECKPOINT_SCHEMA_VERSION,
      rngDraws: 640,
      generationsCompleted: 1,
      population: generation.produced.map((candidate) => ({ fingerprint: candidate.fingerprint, genome: candidate.genome })),
      counts: { attempts: 8, duplicates: 0, evaluated: 8 }
    };
    // JSON round-trip mirrors the JSONB storage path.
    expect(restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
  });

  it("refuses checkpoints whose population no longer reproduces its fingerprints", () => {
    const generation = produceGeneration({ random: createCountingRandom(22).random, populationSize: 8, parents: [], registry: new Set() });
    const member = generation.produced[0]!;
    const tampered = {
      ...freshCheckpoint(),
      generationsCompleted: 1,
      population: [{ fingerprint: member.fingerprint, genome: { ...member.genome, risk: { ...member.genome.risk, stopValue: member.genome.risk.stopValue + 1 } } }]
    };
    expect(() => restoreCheckpoint(tampered)).toThrow(GaEvolutionEngineError);
  });

  it("refuses malformed checkpoints instead of guessing", () => {
    const malformed: unknown[] = [
      null,
      {},
      { ...freshCheckpoint(), schemaVersion: "ga-checkpoint-v2" },
      { ...freshCheckpoint(), rngDraws: -1 },
      { ...freshCheckpoint(), rngDraws: 100_000_001 },
      { ...freshCheckpoint(), generationsCompleted: 17 },
      { ...freshCheckpoint(), counts: { attempts: 0, duplicates: 0 } },
      { ...freshCheckpoint(), extra: true }
    ];
    for (const value of malformed) {
      expect(() => restoreCheckpoint(value), JSON.stringify(value)?.slice(0, 80)).toThrow(GaEvolutionEngineError);
    }
  });
});

describe("objective vector and complexity", () => {
  it("builds the vector in the configured objective order over OOS portfolio metrics", () => {
    const vector = computeObjectiveVector(
      ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"],
      { netProfitPct: 12.5, maxDrawdownPct: 4.25, sharpe: 1.5 },
      321
    );
    expect(Object.keys(vector)).toEqual(["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"]);
    expect(vector).toEqual({ netProfitPct: 12.5, maxDrawdownPct: 4.25, sharpe: 1.5, complexity: 321 });
    expect(computeObjectiveVector(["sharpe", "netProfitPct"], { netProfitPct: 1, maxDrawdownPct: 2, sharpe: 3 }, 0)).toEqual({ sharpe: 3, netProfitPct: 1 });
    expect(() => computeObjectiveVector(["netProfitPct"], { netProfitPct: Number.NaN, maxDrawdownPct: 0, sharpe: 0 }, 0)).toThrow(GaObjectiveError);
  });

  it("measures structural complexity as the canonical JSON byte length", () => {
    const generation = produceGeneration({ random: createCountingRandom(31).random, populationSize: 8, parents: [], registry: new Set() });
    const ir = compileStrategyGenome(generation.produced[0]!.genome);
    expect(strategyComplexity(ir)).toBe(canonicalStrategyJson(ir).length);
    expect(strategyComplexity(ir)).toBeGreaterThan(0);
  });
});

describe("Pareto non-dominated sorting (hand-built golden)", () => {
  const objectives: GaObjectiveKey[] = ["netProfitPct", "maxDrawdownPct"];
  const point = (fingerprint: string, netProfitPct: number, maxDrawdownPct: number) => ({ fingerprint, objectives: { netProfitPct, maxDrawdownPct } });

  it("ranks the known non-dominated set as the rank-0 frontier and layers the rest", () => {
    const points = [
      point("A", 10, 5), // frontier: nothing beats it on both axes
      point("B", 8, 3), //  frontier: best drawdown among high-profit points
      point("C", 12, 9), // frontier: best profit
      point("D", 7, 6), //  dominated by A (10>7, 5<6)
      point("E", 8, 3), //  identical to B: no strict improvement, same layer
      point("F", 6, 7) //   dominated by D (7>6, 6<7) => third layer
    ];
    const ranks = computeParetoRanks(points, objectives);
    expect(Object.fromEntries(ranks)).toEqual({ A: 0, B: 0, C: 0, E: 0, D: 1, F: 2 });
  });

  it("honors objective directions: drawdown and complexity are minimized", () => {
    const full: GaObjectiveKey[] = ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"];
    const vector = (fingerprint: string, values: [number, number, number, number]) => ({
      fingerprint,
      objectives: { netProfitPct: values[0], maxDrawdownPct: values[1], sharpe: values[2], complexity: values[3] }
    });
    const ranks = computeParetoRanks(
      [
        vector("lean", [5, 2, 1, 100]),
        vector("bloated", [5, 2, 1, 400]), // dominated purely by complexity
        vector("risky", [9, 8, 1.4, 100]),
        vector("worst", [4, 9, 0.5, 500]) // dominated by everything, incl. rank-1 "bloated"
      ],
      full
    );
    expect(Object.fromEntries(ranks)).toEqual({ lean: 0, risky: 0, bloated: 1, worst: 2 });
  });

  it("fails closed on missing or non-finite objectives", () => {
    expect(() => computeParetoRanks([{ fingerprint: "X", objectives: { netProfitPct: 1 } }], objectives)).toThrow(GaObjectiveError);
    expect(() => computeParetoRanks([point("Y", Number.POSITIVE_INFINITY, 1)], objectives)).toThrow(GaObjectiveError);
  });
});

describe("out-of-sample report (hand-built golden)", () => {
  const window = (netProfitPct: number, maxDrawdownPct: number, sharpe: number) => ({ netProfitPct, maxDrawdownPct, sharpe });

  it("computes direction-adjusted gaps, loss share, dispersion and clean flags", () => {
    const markets: GaMarketWindowMetrics[] = [
      { symbol: "BTCUSDT", train: window(20, 4, 2), outOfSample: window(12, 6, 1.5) },
      { symbol: "ETHUSDT", train: window(10, 6, 1), outOfSample: window(8, 5, 0.9) }
    ];
    const report = buildOosReport(["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"], markets);
    // max objectives: train - oos; min objectives: oos - train. Positive = worse OOS.
    expect(report.gapPct).toEqual({ netProfitPct: 5, maxDrawdownPct: 0.5, sharpe: 0.3 });
    expect(report.gapPct).not.toHaveProperty("complexity");
    expect(report.oosLossShare).toBe(0);
    expect(report.dispersion).toBe(2);
    expect(report.flags).toEqual({ overfit: false, unstable: false });
  });

  it("flags overfitting when any objective gap crosses its threshold", () => {
    const markets: GaMarketWindowMetrics[] = [{ symbol: "BTCUSDT", train: window(40, 4, 2), outOfSample: window(10, 4, 2) }];
    const report = buildOosReport(["netProfitPct", "maxDrawdownPct", "sharpe"], markets);
    expect(report.gapPct.netProfitPct).toBe(30);
    expect(report.flags.overfit).toBe(true);
    // A single market has zero dispersion by definition.
    expect(report.dispersion).toBe(0);
  });

  it("flags instability on losing-market share and cross-market dispersion", () => {
    const losing: GaMarketWindowMetrics[] = [
      { symbol: "BTCUSDT", train: window(5, 4, 1), outOfSample: window(-2, 4, 0.5) },
      { symbol: "ETHUSDT", train: window(5, 4, 1), outOfSample: window(-1, 4, 0.4) },
      { symbol: "SOLUSDT", train: window(5, 4, 1), outOfSample: window(3, 4, 0.6) }
    ];
    const lossReport = buildOosReport(["netProfitPct"], losing);
    expect(lossReport.oosLossShare).toBeCloseTo(2 / 3, 10);
    expect(lossReport.flags.unstable).toBe(true);

    const dispersed: GaMarketWindowMetrics[] = [
      { symbol: "BTCUSDT", train: window(40, 4, 1), outOfSample: window(60, 4, 1) },
      { symbol: "ETHUSDT", train: window(40, 4, 1), outOfSample: window(-40, 4, 1) }
    ];
    const dispersedReport = buildOosReport(["netProfitPct"], dispersed);
    expect(dispersedReport.dispersion).toBe(50);
    expect(dispersedReport.flags.unstable).toBe(true);

    expect(() => buildOosReport(["netProfitPct"], [])).toThrow(GaObjectiveError);
  });
});
