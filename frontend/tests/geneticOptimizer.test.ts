import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, runBacktest, type BacktestMetrics } from "../src/strategy/backtest";
import { GENETIC_LIMITS, GeneticOptimizationAbortedError, buildGeneticAxes, canonicalParamKey, createGeneticRandom, mutateGenome, optimizeGenetic, scoreGeneticFitness, type GeneticProgress } from "../src/strategy/geneticOptimizer";
import type { StrategyIR } from "../src/strategy/ir";
import { cloneWithInputs } from "../src/strategy/optimizer";
import type { Candle } from "../src/types";

const strategy: StrategyIR = {
  name: "genetic-threshold",
  inputs: [{ name: "threshold", value: 100, min: 95, max: 105, step: 1 }],
  body: [
    { k: "size", mode: "units", value: { k: "num", v: 1 } },
    {
      k: "entry",
      direction: "long",
      when: {
        k: "compare",
        op: ">",
        a: { k: "price", field: "close" },
        b: { k: "input", name: "threshold" }
      }
    },
    {
      k: "exit",
      when: {
        k: "compare",
        op: "<",
        a: { k: "price", field: "close" },
        b: { k: "input", name: "threshold" }
      }
    }
  ]
};

const candles: Candle[] = Array.from({ length: 64 }, (_, index) => {
  const trainingRegime = index < 44;
  const close = trainingRegime ? (index % 4 < 2 ? 98 + (index % 2) : 103 + (index % 2)) : index % 3 === 0 ? 96 : 101 + (index % 2);
  return {
    time: index * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index,
    source: "Genetic fixture"
  };
});

function spec(overrides: Partial<Parameters<typeof optimizeGenetic>[3]> = {}) {
  return {
    params: [{ name: "threshold", min: 95, max: 105, step: 1 }],
    seed: 12345,
    populationSize: 6,
    generations: 4,
    trainFrac: 0.7,
    eliteCount: 1,
    tournamentSize: 3,
    crossoverRate: 0.9,
    mutationRate: 0.4,
    ...overrides
  };
}

function metrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    netProfit: 100,
    netProfitPct: 1,
    totalTrades: 10,
    wins: 6,
    losses: 4,
    winRate: 60,
    profitFactor: 1.5,
    maxDrawdown: 50,
    maxDrawdownPct: 2,
    sharpe: 1,
    avgTrade: 10,
    expectancy: 10,
    timeInMarketPct: 40,
    finalEquity: 10_100,
    avgMaePct: 0,
    avgMfePct: 0,
    fundingPaid: 0,
    liquidated: false,
    ...overrides
  };
}

describe("genetic strategy parameter optimizer", () => {
  it("is exactly reproducible for the same seed and inputs", () => {
    const firstProgress: GeneticProgress[] = [];
    const secondProgress: GeneticProgress[] = [];
    const first = optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec(), {
      onProgress: (progress) => firstProgress.push(progress)
    });
    const second = optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec(), {
      onProgress: (progress) => secondProgress.push(progress)
    });

    expect(second).toEqual(first);
    expect(secondProgress).toEqual(firstProgress);
    expect(first.config.seed).toBe(12345);
    expect(first.processed).toBe(first.config.populationSize * first.config.generations + 1);
    expect(firstProgress.at(-2)).toMatchObject({ phase: "holdout", processed: first.processed - 1, total: first.processed });
    expect(firstProgress.at(-1)).toMatchObject({ phase: "holdout", processed: first.processed, total: first.processed });
  });

  it("enforces StrategyInput bounds and keeps mutations on valid alleles", () => {
    const boundedStrategy: StrategyIR = {
      ...strategy,
      inputs: [{ name: "threshold", value: 100, min: 98, max: 102, step: 1 }]
    };
    const axes = buildGeneticAxes(boundedStrategy, [{ name: "threshold", min: -1_000, max: 1_000, step: 1 }]);

    expect(axes).toEqual([{ name: "threshold", values: [98, 99, 100, 101, 102] }]);
    const mutated = mutateGenome({ threshold: 100 }, axes, createGeneticRandom(7), 1, 1);
    expect(mutated.threshold).not.toBe(100);
    expect(axes[0].values).toContain(mutated.threshold);

    const result = optimizeGenetic(
      boundedStrategy,
      candles,
      DEFAULT_CONFIG,
      spec({
        params: [{ name: "threshold", min: -1_000, max: 1_000, step: 1 }]
      })
    );
    expect(result.ranked.every((candidate) => candidate.params.threshold >= 98 && candidate.params.threshold <= 102)).toBe(true);
  });

  it("uses multi-metric rewards and risk penalties rather than profit alone", () => {
    const robust = metrics({ sharpe: 2, profitFactor: 2, maxDrawdownPct: 2 });
    const fragile = metrics({ sharpe: -1, profitFactor: 0.8, maxDrawdownPct: 20 });
    const policy = optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec({ generations: 1 })).config.fitness;

    const robustScore = scoreGeneticFitness(robust, robust, policy);
    const fragileScore = scoreGeneticFitness(fragile, fragile, policy);
    expect(robust.netProfitPct).toBe(fragile.netProfitPct);
    expect(robustScore.total).toBeGreaterThan(fragileScore.total);
    expect(fragileScore.train.penalty).toBeGreaterThan(robustScore.train.penalty);
  });

  it("uses disjoint train/validation windows for evolution and an untouched test tail for reporting", () => {
    const result = optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec({ generations: 2 }));
    const best = result.best;
    expect(best).toBeDefined();
    expect(result.trainEndIndex).toBe(Math.floor(candles.length * 0.7));
    expect(result.validationEndIndex).toBe(result.trainEndIndex + Math.floor((candles.length - result.trainEndIndex) / 2));
    expect(result.trainBars + result.validationBars + result.testBars).toBe(candles.length);

    const cloned = cloneWithInputs(strategy, best!.params);
    const expectedTrain = runBacktest(cloned, candles.slice(0, result.trainEndIndex), DEFAULT_CONFIG).metrics;
    const expectedValidation = runBacktest(cloned, candles.slice(result.trainEndIndex, result.validationEndIndex), DEFAULT_CONFIG).metrics;
    const expectedTest = runBacktest(cloned, candles.slice(result.validationEndIndex), DEFAULT_CONFIG).metrics;
    expect(best!.trainSample).toEqual(expectedTrain);
    expect(best!.validationSample).toEqual(expectedValidation);
    expect(best!.testSample).toEqual(expectedTest);
    expect(Array.isArray(best!.holdout.reasons)).toBe(true);
    expect(result.holdoutEvaluated).toBe(1);
    expect(result.ranked.slice(1).every((candidate) => candidate.testSample === undefined && candidate.holdout === undefined)).toBe(true);
  });

  it("does not feed changes in the test tail back into evolution, fitness or ranking", () => {
    const first = optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec());
    const changedTail = candles.map((candle, index) => (index < first.validationEndIndex ? candle : { ...candle, open: index % 2 ? 80 : 130, high: index % 2 ? 82 : 132, low: index % 2 ? 78 : 128, close: index % 2 ? 80 : 130 }));
    const second = optimizeGenetic(strategy, changedTail, DEFAULT_CONFIG, spec());
    const searchEvidence = (result: typeof first) =>
      result.ranked.map((candidate) => ({
        params: candidate.params,
        canonicalKey: candidate.canonicalKey,
        generationCreated: candidate.generationCreated,
        fitness: candidate.fitness,
        trainSample: candidate.trainSample,
        validationSample: candidate.validationSample
      }));

    expect(searchEvidence(second)).toEqual(searchEvidence(first));
    expect(second.ranked.map((candidate) => candidate.canonicalKey)).toEqual(first.ranked.map((candidate) => candidate.canonicalKey));
    expect(second.best?.canonicalKey).toBe(first.best?.canonicalKey);
  });

  it("suppresses canonical duplicates across generations", () => {
    const result = optimizeGenetic(
      strategy,
      candles,
      DEFAULT_CONFIG,
      spec({
        params: [{ name: "threshold", values: [99, 99, 100, 100] }],
        populationSize: 50,
        generations: 5
      })
    );

    expect(result.searchSpaceSize).toBe(2);
    expect(result.uniqueEvaluated).toBe(2);
    expect(result.processed).toBe(11);
    expect(result.cacheHits).toBe(8);
    expect(new Set(result.ranked.map((candidate) => candidate.canonicalKey)).size).toBe(result.ranked.length);
    expect(canonicalParamKey({ b: 2, a: 1 })).toBe(canonicalParamKey({ a: 1, b: 2 }));
  });

  it("clamps untrusted population and generation counts to hard limits", () => {
    const populationBound = optimizeGenetic(
      strategy,
      candles.slice(0, 12),
      DEFAULT_CONFIG,
      spec({
        params: [{ name: "threshold", min: 0, max: 1_000, step: 1 }],
        populationSize: Number.MAX_SAFE_INTEGER,
        generations: 1
      })
    );
    expect(populationBound.config.populationSize).toBeLessThanOrEqual(GENETIC_LIMITS.maxPopulation);

    const generationBound = optimizeGenetic(
      strategy,
      candles.slice(0, 12),
      DEFAULT_CONFIG,
      spec({
        params: [{ name: "threshold", values: [100] }],
        populationSize: Number.MAX_SAFE_INTEGER,
        generations: Number.MAX_SAFE_INTEGER
      })
    );
    expect(generationBound.config.generations).toBe(GENETIC_LIMITS.maxGenerations);
    expect(generationBound.config.populationSize).toBe(1);
  });

  it("honours cancellation before and during a synchronous run", () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(() =>
      optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec(), {
        signal: alreadyAborted.signal
      })
    ).toThrow(GeneticOptimizationAbortedError);

    const running = new AbortController();
    let updates = 0;
    expect(() =>
      optimizeGenetic(strategy, candles, DEFAULT_CONFIG, spec(), {
        signal: running.signal,
        onProgress: () => {
          updates += 1;
          if (updates === 2) running.abort();
        }
      })
    ).toThrow(GeneticOptimizationAbortedError);
    expect(updates).toBe(2);
  });

  it("never cherry-picks candidate #2 after the preselected winner fails the final holdout", () => {
    const result = optimizeGenetic(
      strategy,
      candles,
      DEFAULT_CONFIG,
      spec({
        validation: { minTrades: 1_000_000 }
      })
    );
    expect(result.best?.holdout.passed).toBe(false);
    expect(result.bestHoldoutPassed).toBeUndefined();
    expect(result.holdoutEvaluated).toBe(1);
    expect(result.ranked.slice(1).every((candidate) => candidate.holdout === undefined)).toBe(true);
  });

  it("fails closed when an independent split cannot fit the strategy warm-up", () => {
    const longLookback: StrategyIR = {
      ...strategy,
      body: [
        {
          k: "entry",
          direction: "long",
          when: {
            k: "compare",
            op: ">",
            a: { k: "price", field: "close" },
            b: { k: "ma", kind: "sma", period: { k: "num", v: 200 }, source: { k: "price", field: "close" } }
          }
        }
      ]
    };
    const history = Array.from({ length: 500 }, (_, index) => ({ ...candles[index % candles.length]!, time: index * 60_000 }));
    expect(() => optimizeGenetic(longLookback, history, DEFAULT_CONFIG, spec())).toThrow(/requires 200 warm-up bars/);
  });

  it("checks warm-up after applying every candidate genome", () => {
    const dynamicLookback: StrategyIR = {
      ...strategy,
      inputs: [{ name: "period", value: 10, min: 10, max: 200, step: 1 }],
      body: [
        {
          k: "entry",
          direction: "long",
          when: {
            k: "compare",
            op: ">",
            a: { k: "price", field: "close" },
            b: { k: "ma", kind: "sma", period: { k: "input", name: "period" }, source: { k: "price", field: "close" } }
          }
        }
      ]
    };
    const history = Array.from({ length: 500 }, (_, index) => ({ ...candles[index % candles.length]!, time: index * 60_000 }));
    expect(() => optimizeGenetic(dynamicLookback, history, DEFAULT_CONFIG, spec({ params: [{ name: "period", min: 200, max: 200, step: 1 }] }))).toThrow(/genome requires 200 warm-up bars/);
  });

  it("does not reject a safe search space because the unapplied input is unsafe", () => {
    const dynamicLookback: StrategyIR = {
      ...strategy,
      inputs: [{ name: "period", value: 200, min: 10, max: 200, step: 1 }],
      body: [
        {
          k: "entry",
          direction: "long",
          when: {
            k: "compare",
            op: ">",
            a: { k: "price", field: "close" },
            b: { k: "ma", kind: "sma", period: { k: "input", name: "period" }, source: { k: "price", field: "close" } }
          }
        }
      ]
    };
    const history = Array.from({ length: 500 }, (_, index) => ({ ...candles[index % candles.length]!, time: index * 60_000 }));
    const result = optimizeGenetic(dynamicLookback, history, DEFAULT_CONFIG, spec({ params: [{ name: "period", min: 10, max: 10, step: 1 }] }));
    expect(result.best?.params).toEqual({ period: 10 });
    expect(result.requiredWarmupBars).toBe(10);
  });
});
