import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDatasetFingerprint } from "@saltanatbotv2/backtest-core";
import { canonicalStrategyFingerprint } from "@saltanatbotv2/strategy-generator";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshCheckpoint } from "../src/ga/evolution.js";
import type { GaRunRecord } from "../src/ga/repository.js";
import {
  getResearchJobDefinition,
  registerBuiltinResearchJobKinds,
  ResearchJobExecutionError,
  type ResearchJobExecutionContext,
  type ResearchJobInProcessDefinition
} from "../src/jobs/registry.js";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import type { Candle } from "../src/types.js";
import { createBacktestThreadRunner, type BacktestThreadRunner } from "../src/workers/backtestThreadRunner.js";
import { GA_EVOLUTION_RESULT_MAX_BYTES } from "../src/workers/gaEvolutionTask.js";
import type { MultiMarketEvalCandleSource } from "../src/workers/multiMarketEvalTask.js";
import { MemoryGaLineageStore } from "./support/gaLineageStoreMemory.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000201";
const JOB_A = "00000000-0000-4000-8000-000000000202";
const JOB_B = "00000000-0000-4000-8000-000000000203";
const JOB_RESUME = "00000000-0000-4000-8000-000000000204";
const HOUR_MS = 3_600_000;
const BASE_TIME = Date.UTC(2026, 0, 1);

registerBuiltinResearchJobKinds();
const definition = getResearchJobDefinition("ga-evolution") as ResearchJobInProcessDefinition;

// The evaluation side must run through the EXISTING backtestTask worker-thread
// protocol; the suite bundles the real worker entry once and spawns genuine
// worker threads from it (Vitest never emits backend/dist).
let bundleDir: string;
let workerEntry: URL;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "r9b-ga-worker-"));
  const outfile = join(bundleDir, "backtestTask.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/workers/backtestTask.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent"
  });
  workerEntry = pathToFileURL(outfile);
}, 60_000);

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

/** Deterministic wave with drift: positive prices, regular signal crossings. */
function candleHistory(symbol: string, count: number, priceShift = 0): Candle[] {
  const phase = symbol === "BTCUSDT" ? 0 : 3;
  const bars: Candle[] = [];
  let close = 100 + phase;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = 100 + phase + priceShift + 10 * Math.sin((index + phase) / 7) + index * 0.01;
    bars.push({
      time: BASE_TIME + index * HOUR_MS,
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
      volume: 1_000 + (index % 7),
      final: true,
      source: "BinanceKlines"
    });
  }
  return bars;
}

function pagedSource(histories: Map<string, Candle[]>): MultiMarketEvalCandleSource {
  return {
    async getCandles(request) {
      const history = histories.get(request.symbol) ?? [];
      const eligible = request.endTime === undefined ? history : history.filter((bar) => bar.time <= request.endTime!);
      return eligible.slice(-request.limit);
    }
  };
}

function gaConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    markets: ["BTCUSDT", "ETHUSDT"],
    timeframe: "1h",
    lookbackBars: 500,
    split: { trainFraction: 0.7, embargoBars: 8 },
    seed: 1_234,
    population: 8,
    generations: 2,
    objectives: ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"],
    ...overrides
  };
}

interface ContextOverrides {
  jobId?: string;
  signal?: AbortSignal;
  heartbeat?: (progress: number) => void;
  candleSource?: MultiMarketEvalCandleSource;
  backtestRunner?: BacktestThreadRunner;
}

function executionContext(store: MemoryGaLineageStore, payload: Record<string, unknown>, overrides: ContextOverrides = {}): ResearchJobExecutionContext {
  return {
    ownerUserId: OWNER_ID,
    jobId: overrides.jobId ?? JOB_A,
    payload,
    signal: overrides.signal ?? new AbortController().signal,
    heartbeat: overrides.heartbeat ?? (() => undefined),
    logger: () => undefined,
    gaLineage: store,
    candleSource: overrides.candleSource ?? pagedSource(new Map()),
    ...(overrides.backtestRunner ? { backtestRunner: overrides.backtestRunner } : {})
  };
}

/** Real worker-thread runner that records every (strategy, symbol, window) evaluation. */
function trackingRunner(seen: Map<string, number>): BacktestThreadRunner {
  const real = createBacktestThreadRunner({ workerEntry });
  return {
    async run(task, options) {
      const context = task.context as { symbol: string };
      const candles = task.candles as Candle[];
      const fingerprint = canonicalStrategyFingerprint(task.strategy as unknown as StrategyIR);
      const key = `${fingerprint}|${context.symbol}|${candles[0]!.time}|${candles.length}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return real.run(task, options);
    }
  };
}

function unreachableRunner(): BacktestThreadRunner {
  return {
    async run() {
      throw new Error("backtests must not start for this scenario");
    }
  };
}

/** runId is the only value allowed to differ between two runs of one config. */
function withoutRunId(result: Record<string, unknown>): Record<string, unknown> {
  const { runId: _runId, ...rest } = result;
  return rest;
}

function comparableRows(store: MemoryGaLineageStore): Record<string, unknown>[] {
  return store.allCandidateRows().map(({ runId: _runId, ...row }) => row);
}

const checkpointedRun = (runId: string, config: Record<string, unknown>, datasetFingerprint: string): GaRunRecord => ({
  id: runId,
  ownerUserId: OWNER_ID,
  jobId: "00000000-0000-4000-8000-000000000299",
  status: "checkpointed",
  config,
  seed: config.seed as number,
  datasetFingerprint,
  engineVersion: "backtest-core-v1",
  generatorVersion: "bounded-grammar-v1",
  currentGeneration: 0,
  checkpoint: freshCheckpoint() as unknown as Record<string, unknown>,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z"
});

describe("ga-evolution job (real registry + worker-thread backtests)", () => {
  it("THE criterion: same seed + same dataset twice produce a byte-identical result and identical lineage rows", async () => {
    const histories = () =>
      new Map([
        ["BTCUSDT", candleHistory("BTCUSDT", 520)],
        ["ETHUSDT", candleHistory("ETHUSDT", 520)]
      ]);
    const heartbeats: number[] = [];
    const seenA = new Map<string, number>();
    const storeA = new MemoryGaLineageStore();
    const first = await definition.run(
      executionContext(storeA, { kind: "ga-evolution", mode: "start", config: gaConfig() }, {
        candleSource: pagedSource(histories()),
        backtestRunner: trackingRunner(seenA),
        heartbeat: (progress) => heartbeats.push(progress)
      })
    );
    const seenB = new Map<string, number>();
    const storeB = new MemoryGaLineageStore();
    const second = await definition.run(
      executionContext(storeB, { kind: "ga-evolution", mode: "start", config: gaConfig() }, {
        jobId: JOB_B,
        candleSource: pagedSource(histories()),
        backtestRunner: trackingRunner(seenB)
      })
    );

    // Determinism is the release criterion: same seed + dataset => same bytes.
    expect(JSON.stringify(withoutRunId(second))).toBe(JSON.stringify(withoutRunId(first)));
    // ... and the durable ga_candidates lineage matches row for row
    // (fingerprints, parents, mutation logs, objectives, ranks, OOS reports).
    const rowsA = comparableRows(storeA);
    expect(rowsA.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(comparableRows(storeB))).toBe(JSON.stringify(rowsA));

    expect(first).toMatchObject({
      schemaVersion: "ga-evolution-v1",
      status: "completed",
      generationsCompleted: 2,
      engineVersion: "backtest-core-v1",
      generatorVersion: "bounded-grammar-v1",
      seed: 1_234
    });
    // dataset-v1 provenance: the pinned fingerprint is exactly the descriptor
    // fingerprint of the evaluated 500-bar windows.
    const window = (symbol: string) => histories().get(symbol)!.slice(-500);
    expect(first.datasetFingerprint).toBe(
      computeDatasetFingerprint("binance:spot:last", "1h", new Map([["BTCUSDT", window("BTCUSDT")], ["ETHUSDT", window("ETHUSDT")]]))
    );

    // Frontier: rank-sorted, rank 0 first, every entry carrying OOS evidence.
    const frontier = first.frontier as Record<string, unknown>[];
    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier[0]!.paretoRank).toBe(0);
    for (const entry of frontier) {
      expect(entry.fingerprint).toMatch(/^strategy-v1-[0-9a-f]{16}-\d+$/);
      expect(Object.keys(entry.objectives as Record<string, number>)).toEqual(["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"]);
      expect(entry.oosReport).toMatchObject({ flags: { overfit: expect.any(Boolean), unstable: expect.any(Boolean) } });
    }

    // Dedup accounting: every evaluated candidate ran exactly 2 windows x 2
    // markets, no (candidate, window) pair ever twice, duplicates never ran.
    const counts = first.counts as Record<string, number>;
    expect(counts.attempts).toBe(counts.evaluated + counts.duplicates);
    expect(counts.backtests).toBe(counts.evaluated * 2 * 2);
    expect([...seenA.values()].every((timesRun) => timesRun === 1)).toBe(true);
    expect(seenA.size).toBe(counts.evaluated * 2 * 2);
    expect(counts.evaluated).toBe(rowsA.length);

    // Generational lineage: generation 1 rows are seeds, generation 2 breeds.
    const generations = new Set(rowsA.map((row) => row.generation));
    expect(generations).toEqual(new Set([1, 2]));
    const known = new Set(rowsA.map((row) => row.fingerprint));
    for (const row of rowsA) {
      if (row.generation === 1) expect(row.parentFingerprints).toEqual([]);
      for (const parent of row.parentFingerprints as string[]) expect(known.has(parent)).toBe(true);
      expect(row.paretoRank).toBeGreaterThanOrEqual(0);
      expect(row.oosReport).toBeDefined();
      expect((row.metrics as { markets: unknown[] }).markets).toHaveLength(2);
    }

    // (h) bounded result; monotone phase-scaled heartbeats.
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(GA_EVOLUTION_RESULT_MAX_BYTES);
    expect(heartbeats[0]).toBe(0.05);
    expect(heartbeats.at(-1)).toBe(0.98);
    for (let index = 1; index < heartbeats.length; index += 1) {
      expect(heartbeats[index]).toBeGreaterThanOrEqual(heartbeats[index - 1]!);
    }

    // The run row is terminal with the full 2-generation checkpoint retained.
    const run = storeA.runSnapshot(first.runId as string)!;
    expect(run).toMatchObject({ status: "completed", currentGeneration: 2, datasetFingerprint: first.datasetFingerprint });
  }, 240_000);

  it("cancel after generation 1 checkpoints, and resume finishes identically to an uninterrupted run", async () => {
    const config = gaConfig({ markets: ["BTCUSDT"], seed: 77 });
    const histories = () => new Map([["BTCUSDT", candleHistory("BTCUSDT", 520)]]);

    // Baseline: the uninterrupted run.
    const storeU = new MemoryGaLineageStore();
    const seenU = new Map<string, number>();
    const uninterrupted = await definition.run(
      executionContext(storeU, { kind: "ga-evolution", mode: "start", config }, {
        candleSource: pagedSource(histories()),
        backtestRunner: trackingRunner(seenU)
      })
    );
    expect(uninterrupted.status).toBe("completed");

    // Interrupted run: abort as soon as generation 1 became durable. The job
    // completes with a resumable checkpointed result — NOT a hard failure.
    const storeI = new MemoryGaLineageStore();
    const abort = new AbortController();
    const originalRecord = storeI.recordGeneration.bind(storeI);
    storeI.recordGeneration = async (runId, input) => {
      await originalRecord(runId, input);
      if (input.generation === 1) abort.abort();
    };
    const seenShared = new Map<string, number>();
    const interrupted = await definition.run(
      executionContext(storeI, { kind: "ga-evolution", mode: "start", config }, {
        jobId: JOB_B,
        signal: abort.signal,
        candleSource: pagedSource(histories()),
        backtestRunner: trackingRunner(seenShared)
      })
    );
    expect(interrupted).toMatchObject({ schemaVersion: "ga-evolution-v1", status: "checkpointed", generationsCompleted: 1 });
    const runId = interrupted.runId as string;
    expect(storeI.runSnapshot(runId)).toMatchObject({ status: "checkpointed", currentGeneration: 1 });
    expect(comparableRows(storeI).every((row) => row.generation === 1)).toBe(true);

    // Resume from the durable checkpoint under a NEW job: the final state is
    // identical to never having stopped — fingerprint sets, rows and result.
    const resumed = await definition.run(
      executionContext(storeI, { kind: "ga-evolution", mode: "resume", runId }, {
        jobId: JOB_RESUME,
        candleSource: pagedSource(histories()),
        backtestRunner: trackingRunner(seenShared)
      })
    );
    expect(JSON.stringify(withoutRunId(resumed))).toBe(JSON.stringify(withoutRunId(uninterrupted)));
    expect(JSON.stringify(comparableRows(storeI))).toBe(JSON.stringify(comparableRows(storeU)));
    expect(storeI.runSnapshot(runId)).toMatchObject({ status: "completed", currentGeneration: 2, jobId: JOB_RESUME });

    // Dedup across the checkpoint boundary: generation-1 candidates were NEVER
    // re-evaluated on resume; interrupted + resumed spend exactly the
    // uninterrupted backtest budget, one run per (candidate, window).
    expect([...seenShared.values()].every((timesRun) => timesRun === 1)).toBe(true);
    expect(seenShared.size).toBe(seenU.size);
    expect([...seenShared.keys()].sort()).toEqual([...seenU.keys()].sort());
  }, 240_000);

  it("fails a resume explicitly with ga_dataset_drift when the refetched bars no longer reproduce the pinned fingerprint", async () => {
    const config = gaConfig({ markets: ["BTCUSDT"], seed: 9 });
    const store = new MemoryGaLineageStore();
    const runId = "00000000-0000-4000-8000-000000000205";
    store.seedRun(checkpointedRun(runId, config, "b".repeat(64)));

    const failure = await definition
      .run(
        executionContext(store, { kind: "ga-evolution", mode: "resume", runId }, {
          jobId: JOB_RESUME,
          candleSource: pagedSource(new Map([["BTCUSDT", candleHistory("BTCUSDT", 520, 25)]])),
          backtestRunner: unreachableRunner()
        })
      )
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ResearchJobExecutionError);
    expect((failure as ResearchJobExecutionError).code).toBe("ga_dataset_drift");
    expect((failure as ResearchJobExecutionError).message).toContain("b".repeat(64));
    // Determinism is never silently violated: the run fails, no backtest ran.
    expect(store.runSnapshot(runId)).toMatchObject({ status: "failed" });
  });

  it("refuses to start while another run is active for the owner (single-active-run invariant)", async () => {
    const store = new MemoryGaLineageStore();
    store.seedRun({ ...checkpointedRun("00000000-0000-4000-8000-000000000206", gaConfig(), "c".repeat(64)), status: "running" });
    const failure = await definition
      .run(executionContext(store, { kind: "ga-evolution", mode: "start", config: gaConfig() }, { backtestRunner: unreachableRunner() }))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ResearchJobExecutionError);
    expect((failure as ResearchJobExecutionError).code).toBe("ga_run_active");
  });

  it("rejects resumes of unknown or terminal runs with explicit codes", async () => {
    const store = new MemoryGaLineageStore();
    const missing = await definition
      .run(executionContext(store, { kind: "ga-evolution", mode: "resume", runId: "00000000-0000-4000-8000-000000000207" }, { backtestRunner: unreachableRunner() }))
      .catch((error) => error);
    expect((missing as ResearchJobExecutionError).code).toBe("ga_run_not_found");

    const completedId = "00000000-0000-4000-8000-000000000208";
    store.seedRun({ ...checkpointedRun(completedId, gaConfig(), "d".repeat(64)), status: "completed" });
    const terminal = await definition
      .run(executionContext(store, { kind: "ga-evolution", mode: "resume", runId: completedId }, { backtestRunner: unreachableRunner() }))
      .catch((error) => error);
    expect((terminal as ResearchJobExecutionError).code).toBe("ga_run_not_resumable");
  });

  it("re-validates the durable payload at execution time", async () => {
    const store = new MemoryGaLineageStore();
    const invalidPayloads: Record<string, unknown>[] = [
      { kind: "ga-evolution", mode: "start", config: gaConfig({ population: 4 }) },
      { kind: "ga-evolution", mode: "start", config: gaConfig({ generations: 17 }) },
      { kind: "ga-evolution", mode: "start" },
      { kind: "ga-evolution", mode: "resume", runId: "not-a-uuid" }
    ];
    for (const payload of invalidPayloads) {
      const failure = await definition
        .run(executionContext(store, payload, { backtestRunner: unreachableRunner() }))
        .catch((error) => error);
      expect((failure as ResearchJobExecutionError).code, JSON.stringify(payload).slice(0, 100)).toBe("ga_payload_invalid");
    }
  });
});
