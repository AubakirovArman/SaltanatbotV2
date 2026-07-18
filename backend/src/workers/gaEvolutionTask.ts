import { randomUUID } from "node:crypto";
import {
  BACKTEST_ENGINE_VERSION,
  DATASET_EMBARGO_BARS_MAXIMUM,
  DATASET_TRAIN_FRACTION_MAXIMUM,
  DATASET_TRAIN_FRACTION_MINIMUM,
  simulatePortfolioBacktest,
  type BacktestResult
} from "@saltanatbotv2/backtest-core";
import { z } from "zod";
import {
  createCountingRandom,
  freshCheckpoint,
  GA_CHECKPOINT_SCHEMA_VERSION,
  GA_GENERATOR_VERSION,
  GaEvolutionEngineError,
  produceGeneration,
  restoreCheckpoint,
  type GaBreedingParent,
  type GaCheckpoint,
  type GaProducedCandidate
} from "../ga/evolution.js";
import {
  buildOosReport,
  computeObjectiveVector,
  computeParetoRanks,
  GA_OBJECTIVE_KEYS,
  GaObjectiveError,
  strategyComplexity,
  type GaMarketWindowMetrics,
  type GaObjectiveKey,
  type GaParetoPoint
} from "../ga/objectives.js";
import { GaRunActiveError, type GaEvolutionLineageStore, type GaNewCandidateInput, type GaRunRecord } from "../ga/repository.js";
import { serializeComputeJobResult, ComputeJobResultRejectedError } from "../jobs/resultPayload.js";
import { timeframes } from "../market/timeframes.js";
import type { Candle } from "../types.js";
import { createBacktestThreadRunner } from "./backtestThreadRunner.js";
import {
  buildEvalDataset,
  compactPortfolioSection,
  createCatalogCandleSource,
  evaluationSection,
  fetchAllMarketBars,
  MULTI_MARKET_EVAL_INITIAL_CAPITAL,
  MULTI_MARKET_EVAL_LOOKBACK_MAXIMUM,
  MULTI_MARKET_EVAL_LOOKBACK_MINIMUM,
  MultiMarketEvalTaskError,
  portfolioLegReport,
  runWindowBacktest,
  splitAllMarkets,
  type MultiMarketEvalBacktestRunner,
  type MultiMarketEvalCandleSource,
  type MultiMarketEvalMarket,
  type MultiMarketEvalTaskDependencies
} from "./multiMarketEvalTask.js";

/**
 * In-process "ga-evolution" job executor (ADR 0003 / R9.2): one dataset fetch
 * per run through the multi-market-eval discipline (real closed bars only,
 * dataset-v1 fingerprint), then seeded generations of structural candidates
 * from the PURE strategy-generator package, each NEW candidate evaluated
 * train+OOS per market through the backtestTask worker-thread protocol.
 * Lineage, Pareto ranks and a resume checkpoint persist after every
 * generation; cancellation between candidates checkpoints instead of failing.
 * Roadmap criterion: same seed + same dataset produce the same result — even
 * across checkpoint/resume — and a resume whose refetched dataset no longer
 * reproduces the pinned fingerprint fails explicitly (ga_dataset_drift).
 */

export const GA_EVOLUTION_JOB_TIMEOUT_MS = 600_000;
export const GA_EVOLUTION_SCHEMA_VERSION = "ga-evolution-v1";
export const GA_EVOLUTION_RESULT_MAX_BYTES = 256 * 1024;
export const GA_EVOLUTION_MARKETS_MAXIMUM = 4;
export const GA_EVOLUTION_POPULATION_MINIMUM = 8;
export const GA_EVOLUTION_POPULATION_MAXIMUM = 64;
export const GA_EVOLUTION_GENERATIONS_MAXIMUM = 16;
export const GA_EVOLUTION_SEED_MAXIMUM = 4_294_967_295;
export const GA_EVOLUTION_FRONTIER_LIMIT = 16;
export const GA_EVOLUTION_PARETO_SUMMARY_LIMIT = 32;
export const GA_EVOLUTION_RESUME_ESTIMATED_COST = 10_000;

export class GaEvolutionTaskError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GaEvolutionTaskError";
  }
}

const gaMarketsSchema = z
  .array(z.string().regex(/^[A-Z0-9]{2,40}$/, "Symbol must be an uppercase exchange symbol."))
  .min(1)
  .max(GA_EVOLUTION_MARKETS_MAXIMUM)
  .superRefine((markets, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < markets.length; index += 1) {
      if (seen.has(markets[index]!)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Market symbols must be unique.", path: [index] });
      }
      seen.add(markets[index]!);
    }
  });

const gaObjectivesSchema = z
  .array(z.enum(GA_OBJECTIVE_KEYS))
  .min(2)
  .max(GA_OBJECTIVE_KEYS.length)
  .superRefine((objectives, context) => {
    if (new Set(objectives).size !== objectives.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Objectives must be unique." });
    }
  });

/** Bounded GA run config; stored verbatim (defaults resolved) in ga_runs.config. */
export const gaEvolutionConfigSchema = z.object({
  markets: gaMarketsSchema,
  timeframe: z.string().refine((value) => (timeframes as readonly string[]).includes(value), "Unsupported timeframe."),
  lookbackBars: z.number().int().min(MULTI_MARKET_EVAL_LOOKBACK_MINIMUM).max(MULTI_MARKET_EVAL_LOOKBACK_MAXIMUM),
  split: z.object({
    trainFraction: z.number().finite().min(DATASET_TRAIN_FRACTION_MINIMUM).max(DATASET_TRAIN_FRACTION_MAXIMUM).default(0.7),
    embargoBars: z.number().int().min(0).max(DATASET_EMBARGO_BARS_MAXIMUM).default(8)
  }).strict().default({ trainFraction: 0.7, embargoBars: 8 }),
  seed: z.number().int().min(0).max(GA_EVOLUTION_SEED_MAXIMUM),
  population: z.number().int().min(GA_EVOLUTION_POPULATION_MINIMUM).max(GA_EVOLUTION_POPULATION_MAXIMUM),
  generations: z.number().int().min(1).max(GA_EVOLUTION_GENERATIONS_MAXIMUM),
  objectives: gaObjectivesSchema.default([...GA_OBJECTIVE_KEYS])
}).strict();

export type GaEvolutionConfig = z.infer<typeof gaEvolutionConfigSchema>;

const clientRequestIdSchema = z.string().min(8).max(128).optional();

/** HTTP enqueue body (spec §3): start a new run or resume a checkpointed one. */
export const gaEvolutionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ kind: z.literal("ga-evolution"), mode: z.literal("start"), config: gaEvolutionConfigSchema, clientRequestId: clientRequestIdSchema }).strict(),
  z.object({ kind: z.literal("ga-evolution"), mode: z.literal("resume"), runId: z.string().uuid(), clientRequestId: clientRequestIdSchema }).strict()
]);

/** Durable payload shape re-validated at execution time (defaults resolved). */
const gaEvolutionPayloadSchema = z.discriminatedUnion("mode", [
  z.object({ kind: z.literal("ga-evolution"), mode: z.literal("start"), config: gaEvolutionConfigSchema }).strict(),
  z.object({ kind: z.literal("ga-evolution"), mode: z.literal("resume"), runId: z.string().uuid() }).strict()
]);

type GaEvolutionPayload = z.infer<typeof gaEvolutionPayloadSchema>;

export function gaEvaluationMarkets(config: Pick<GaEvolutionConfig, "markets" | "timeframe">): MultiMarketEvalMarket[] {
  return config.markets.map((symbol) => ({ symbol, timeframe: config.timeframe }));
}

export interface GaEvolutionTaskInput {
  ownerUserId: string;
  jobId: string;
  payload: unknown;
  signal?: AbortSignal;
  heartbeat?: (progress: number) => void;
}

export interface GaEvolutionTaskDependencies {
  lineage: GaEvolutionLineageStore;
  candleSource?: MultiMarketEvalCandleSource;
  backtestRunner?: MultiMarketEvalBacktestRunner;
  now?: () => number;
  fetchBudgetMs?: number;
  concurrency?: number;
  backtestTimeoutMs?: number;
}

export async function runGaEvolutionTask(input: GaEvolutionTaskInput, dependencies: GaEvolutionTaskDependencies): Promise<Record<string, unknown>> {
  const request = parseGaPayload(input.payload);
  const run = await resolveRun(request, input, dependencies.lineage);
  try {
    return await executeRun(run, input, dependencies);
  } catch (error) {
    await dependencies.lineage.finishRun(run.id, { status: "failed" }).catch(() => undefined);
    throw mapTaskError(error);
  }
}

function parseGaPayload(payload: unknown): GaEvolutionPayload {
  const parsed = gaEvolutionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    throw new GaEvolutionTaskError("ga_payload_invalid", `GA evolution payload is invalid: ${detail}`);
  }
  return parsed.data;
}

/**
 * One durable run row per logical evolution. A retried attempt of the same
 * compute job adopts its existing row (crash recovery is resume semantics);
 * start creates a fresh row behind the one-active-per-owner unique index.
 */
async function resolveRun(request: GaEvolutionPayload, input: GaEvolutionTaskInput, lineage: GaEvolutionLineageStore): Promise<GaRunRecord> {
  const adopted = await lineage.findRunByJobId(input.ownerUserId, input.jobId);
  if (adopted) {
    if (adopted.status === "running") return adopted;
    if (adopted.status === "checkpointed") {
      const reclaimed = await claimResumeMapped(lineage, input.ownerUserId, adopted.id, input.jobId);
      if (reclaimed) return reclaimed;
    }
    throw new GaEvolutionTaskError("ga_run_not_resumable", `GA run ${adopted.id} is ${adopted.status} and cannot continue under this job.`);
  }
  if (request.mode === "start") {
    await lineage.failOrphanedRuns(input.ownerUserId);
    try {
      return await lineage.createRun({
        id: randomUUID(),
        ownerUserId: input.ownerUserId,
        jobId: input.jobId,
        config: request.config as unknown as Record<string, unknown>,
        seed: request.config.seed,
        engineVersion: BACKTEST_ENGINE_VERSION,
        generatorVersion: GA_GENERATOR_VERSION
      });
    } catch (error) {
      if (error instanceof GaRunActiveError) throw new GaEvolutionTaskError("ga_run_active", error.message);
      throw error;
    }
  }
  const claimed = await claimResumeMapped(lineage, input.ownerUserId, request.runId, input.jobId);
  if (claimed) return claimed;
  const run = await lineage.getRun(input.ownerUserId, request.runId);
  if (!run) throw new GaEvolutionTaskError("ga_run_not_found", "GA run not found.");
  throw new GaEvolutionTaskError("ga_run_not_resumable", `GA run is ${run.status} and cannot be resumed.`);
}

async function claimResumeMapped(lineage: GaEvolutionLineageStore, ownerUserId: string, runId: string, jobId: string): Promise<GaRunRecord | undefined> {
  try {
    return await lineage.claimResume(ownerUserId, runId, jobId);
  } catch (error) {
    if (error instanceof GaRunActiveError) throw new GaEvolutionTaskError("ga_run_active", error.message);
    throw error;
  }
}

interface GaBoundaryState {
  rngDraws: number;
  generationsCompleted: number;
  population: GaBreedingParent[];
  counts: { attempts: number; duplicates: number; evaluated: number };
}

async function executeRun(run: GaRunRecord, input: GaEvolutionTaskInput, dependencies: GaEvolutionTaskDependencies): Promise<Record<string, unknown>> {
  const heartbeat = input.heartbeat ?? (() => undefined);
  const lineage = dependencies.lineage;
  const config = parseStoredConfig(run.config);
  const markets = gaEvaluationMarkets(config);
  const candleSource = dependencies.candleSource ?? createCatalogCandleSource();
  const backtestRunner = dependencies.backtestRunner ?? createBacktestThreadRunner();
  const evalDependencies: MultiMarketEvalTaskDependencies = {
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.fetchBudgetMs !== undefined ? { fetchBudgetMs: dependencies.fetchBudgetMs } : {}),
    ...(dependencies.concurrency !== undefined ? { concurrency: dependencies.concurrency } : {}),
    ...(dependencies.backtestTimeoutMs !== undefined ? { backtestTimeoutMs: dependencies.backtestTimeoutMs } : {})
  };
  const checkpoint = restoreRunCheckpoint(run);
  const boundary: GaBoundaryState = {
    rngDraws: checkpoint.rngDraws,
    generationsCompleted: checkpoint.generationsCompleted,
    population: checkpoint.population.map((member) => ({ fingerprint: member.fingerprint, genome: member.genome })),
    counts: { ...checkpoint.counts }
  };
  const prior = await lineage.restoreObjectives(run.id);
  const registry = new Set(prior.map((row) => row.fingerprint));
  const evaluated: GaParetoPoint[] = prior.map((row) => ({ fingerprint: row.fingerprint, objectives: row.objectives }));
  const oosReports = new Map<string, Record<string, unknown>>();
  for (const row of prior) if (row.oosReport) oosReports.set(row.fingerprint, row.oosReport);
  let datasetFingerprint = run.datasetFingerprint ?? null;

  const checkpointAndReport = async (): Promise<Record<string, unknown>> => {
    const result = buildRunResult({ run, config, status: "checkpointed", boundary, evaluated, oosReports, datasetFingerprint });
    await lineage.finishRun(run.id, { status: "checkpointed", checkpoint: boundaryCheckpoint(boundary) });
    return result;
  };

  // --- dataset: fetched ONCE per run, pinned by its dataset-v1 fingerprint ---
  let windows: Map<string, { train: Candle[]; test: Candle[] }>;
  try {
    heartbeat(0.05);
    const barsBySymbol = await fetchAllMarketBars({ markets, lookbackBars: config.lookbackBars }, candleSource, evalDependencies, input.signal, heartbeat);
    const dataset = buildEvalDataset({ split: config.split }, config.timeframe, barsBySymbol);
    if (datasetFingerprint && datasetFingerprint !== dataset.fingerprint) {
      throw new GaEvolutionTaskError(
        "ga_dataset_drift",
        `The refetched dataset (${dataset.fingerprint}) no longer reproduces the pinned fingerprint ${datasetFingerprint}; deterministic resume is impossible.`
      );
    }
    if (!datasetFingerprint) {
      await lineage.setDatasetFingerprint(run.id, dataset.fingerprint);
      datasetFingerprint = dataset.fingerprint;
    }
    windows = splitAllMarkets({ markets, split: config.split }, barsBySymbol);
  } catch (error) {
    if (isAbort(error, input.signal)) return checkpointAndReport();
    throw error;
  }
  heartbeat(0.45);

  // --- seeded generations; the RNG state is exactly the checkpointed draw count ---
  const rng = createCountingRandom(config.seed, boundary.rngDraws);
  try {
    for (let generation = boundary.generationsCompleted + 1; generation <= config.generations; generation += 1) {
      if (input.signal?.aborted) return await checkpointAndReport();
      const outcome = produceGeneration({ random: rng.random, populationSize: config.population, parents: boundary.population, registry });
      if (outcome.produced.length === 0) break; // Grammar exhausted: nothing new to evaluate.
      const newCandidates: GaNewCandidateInput[] = [];
      const newPoints: GaParetoPoint[] = [];
      for (let index = 0; index < outcome.produced.length; index += 1) {
        // Cancellation is honored between candidates: the interrupted
        // generation is discarded and replayed identically on resume.
        if (input.signal?.aborted) return await checkpointAndReport();
        const candidate = outcome.produced[index]!;
        const row = await evaluateCandidate(candidate, generation, markets, windows, backtestRunner, evalDependencies, input.signal, config.objectives);
        newCandidates.push(row);
        newPoints.push({ fingerprint: row.fingerprint, objectives: row.objectives });
        heartbeat(0.45 + 0.5 * ((generation - 1 + (index + 1) / outcome.produced.length) / config.generations));
      }
      const allPoints = [...evaluated, ...newPoints];
      const ranks = computeParetoRanks(allPoints, config.objectives);
      const nextBoundary: GaBoundaryState = {
        rngDraws: rng.draws(),
        generationsCompleted: generation,
        population: selectBreedingPool(outcome.produced, ranks, config.population),
        counts: {
          attempts: boundary.counts.attempts + outcome.attempts,
          duplicates: boundary.counts.duplicates + outcome.duplicates,
          evaluated: boundary.counts.evaluated + newCandidates.length
        }
      };
      await lineage.recordGeneration(run.id, {
        generation,
        candidates: newCandidates,
        paretoRanks: ranks,
        pareto: paretoSummary(generation, allPoints, ranks),
        checkpoint: boundaryCheckpoint(nextBoundary)
      });
      // The in-memory state only advances once the generation is durable, so a
      // late abort can never checkpoint ahead of the recorded lineage.
      evaluated.push(...newPoints);
      for (const row of newCandidates) oosReports.set(row.fingerprint, row.oosReport);
      boundary.rngDraws = nextBoundary.rngDraws;
      boundary.generationsCompleted = nextBoundary.generationsCompleted;
      boundary.population = nextBoundary.population;
      boundary.counts = nextBoundary.counts;
    }
  } catch (error) {
    if (isAbort(error, input.signal)) return checkpointAndReport();
    throw error;
  }

  heartbeat(0.98);
  const result = buildRunResult({ run, config, status: "completed", boundary, evaluated, oosReports, datasetFingerprint });
  await lineage.finishRun(run.id, { status: "completed" });
  return result;
}

function parseStoredConfig(value: Record<string, unknown>): GaEvolutionConfig {
  const parsed = gaEvolutionConfigSchema.safeParse(value);
  if (!parsed.success) throw new GaEvolutionTaskError("ga_run_config_invalid", "Stored GA run configuration is invalid.");
  return parsed.data;
}

function restoreRunCheckpoint(run: GaRunRecord): GaCheckpoint {
  if (!run.checkpoint) return freshCheckpoint();
  const checkpoint = restoreCheckpoint(run.checkpoint);
  if (checkpoint.generationsCompleted !== run.currentGeneration) {
    throw new GaEvolutionEngineError("Stored GA checkpoint disagrees with the run's generation counter.");
  }
  return checkpoint;
}

function boundaryCheckpoint(boundary: GaBoundaryState): GaCheckpoint {
  return {
    schemaVersion: GA_CHECKPOINT_SCHEMA_VERSION,
    rngDraws: boundary.rngDraws,
    generationsCompleted: boundary.generationsCompleted,
    population: boundary.population.map((member) => ({ fingerprint: member.fingerprint, genome: member.genome })),
    counts: { ...boundary.counts }
  };
}

/** Next generation breeds from this generation's candidates, best Pareto ranks first. */
function selectBreedingPool(produced: readonly GaProducedCandidate[], ranks: ReadonlyMap<string, number>, populationSize: number): GaBreedingParent[] {
  return [...produced]
    .map((candidate) => ({ candidate, rank: ranks.get(candidate.fingerprint) ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.rank - right.rank || compareText(left.candidate.fingerprint, right.candidate.fingerprint))
    .slice(0, populationSize)
    .map(({ candidate }) => ({ fingerprint: candidate.fingerprint, genome: candidate.genome }));
}

async function evaluateCandidate(
  candidate: GaProducedCandidate,
  generation: number,
  markets: readonly MultiMarketEvalMarket[],
  windows: Map<string, { train: Candle[]; test: Candle[] }>,
  runner: MultiMarketEvalBacktestRunner,
  dependencies: MultiMarketEvalTaskDependencies,
  signal: AbortSignal | undefined,
  objectives: readonly GaObjectiveKey[]
): Promise<GaNewCandidateInput> {
  const marketSections: Record<string, unknown>[] = [];
  const windowMetrics: GaMarketWindowMetrics[] = [];
  const legs: { symbol: string; candles: Candle[]; report: BacktestResult }[] = [];
  for (const market of markets) {
    const window = windows.get(market.symbol)!;
    const trainReport = await runWindowBacktest(runner, candidate.ir, market, window.train, dependencies, signal);
    const testReport = await runWindowBacktest(runner, candidate.ir, market, window.test, dependencies, signal);
    const train = evaluationSection(market.symbol, trainReport, window.train.length);
    const outOfSample = evaluationSection(market.symbol, testReport, window.test.length);
    marketSections.push({ symbol: market.symbol, timeframe: market.timeframe, train, outOfSample });
    windowMetrics.push({ symbol: market.symbol, train: readWindowMetrics(market.symbol, train), outOfSample: readWindowMetrics(market.symbol, outOfSample) });
    legs.push({ symbol: market.symbol, candles: window.test, report: portfolioLegReport(market.symbol, testReport) });
  }
  const portfolio = compactPortfolioSection(simulatePortfolioBacktest(legs, { initialCapital: MULTI_MARKET_EVAL_INITIAL_CAPITAL }));
  const portfolioOutOfSample = readWindowMetrics("portfolio", portfolio.metrics as Record<string, unknown>);
  try {
    return {
      fingerprint: candidate.fingerprint,
      generation,
      parentFingerprints: candidate.parentFingerprints,
      mutationLog: candidate.mutationLog,
      ir: candidate.ir as unknown as Record<string, unknown>,
      metrics: { markets: marketSections, portfolio },
      objectives: computeObjectiveVector(objectives, portfolioOutOfSample, strategyComplexity(candidate.ir)),
      oosReport: buildOosReport(objectives, windowMetrics) as unknown as Record<string, unknown>
    };
  } catch (error) {
    if (error instanceof GaObjectiveError) {
      throw new GaEvolutionTaskError("ga_evaluation_invalid", `Candidate ${candidate.fingerprint} produced unusable metrics: ${error.message}`);
    }
    throw error;
  }
}

function readWindowMetrics(label: string, section: Record<string, unknown>): { netProfitPct: number; maxDrawdownPct: number; sharpe: number } {
  const values: Record<string, number> = {};
  for (const key of ["netProfitPct", "maxDrawdownPct", "sharpe"] as const) {
    const value = section[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new GaEvolutionTaskError("ga_backtest_invalid_response", `Backtest metrics for ${label} are missing a finite ${key}.`);
    }
    values[key] = value;
  }
  return { netProfitPct: values.netProfitPct!, maxDrawdownPct: values.maxDrawdownPct!, sharpe: values.sharpe! };
}

/** Bounded frontier summary stored on ga_runs.pareto after every generation. */
function paretoSummary(generation: number, points: readonly GaParetoPoint[], ranks: ReadonlyMap<string, number>): Record<string, unknown> {
  const frontier = points
    .filter((point) => ranks.get(point.fingerprint) === 0)
    .map((point) => ({ fingerprint: point.fingerprint, objectives: point.objectives, paretoRank: 0 }))
    .sort((left, right) => compareText(left.fingerprint, right.fingerprint))
    .slice(0, GA_EVOLUTION_PARETO_SUMMARY_LIMIT);
  return { schemaVersion: "ga-pareto-v1", generation, totalCandidates: points.length, frontier };
}

function buildRunResult(input: {
  run: GaRunRecord;
  config: GaEvolutionConfig;
  status: "completed" | "checkpointed";
  boundary: GaBoundaryState;
  evaluated: readonly GaParetoPoint[];
  oosReports: ReadonlyMap<string, Record<string, unknown>>;
  datasetFingerprint: string | null;
}): Record<string, unknown> {
  const ranks = input.evaluated.length > 0 ? computeParetoRanks(input.evaluated, input.config.objectives) : new Map<string, number>();
  const frontier = [...input.evaluated]
    .map((point) => ({ fingerprint: point.fingerprint, objectives: point.objectives, paretoRank: ranks.get(point.fingerprint) ?? 0 }))
    .sort((left, right) => left.paretoRank - right.paretoRank || compareText(left.fingerprint, right.fingerprint))
    .slice(0, GA_EVOLUTION_FRONTIER_LIMIT)
    .map((entry) => {
      const report = input.oosReports.get(entry.fingerprint);
      return { ...entry, ...(report ? { oosReport: report } : {}) };
    });
  const result: Record<string, unknown> = {
    schemaVersion: GA_EVOLUTION_SCHEMA_VERSION,
    runId: input.run.id,
    status: input.status,
    generationsCompleted: input.boundary.generationsCompleted,
    datasetFingerprint: input.datasetFingerprint,
    engineVersion: input.run.engineVersion,
    generatorVersion: input.run.generatorVersion,
    seed: input.config.seed,
    frontier,
    counts: {
      evaluated: input.boundary.counts.evaluated,
      attempts: input.boundary.counts.attempts,
      duplicates: input.boundary.counts.duplicates,
      backtests: input.boundary.counts.evaluated * input.config.markets.length * 2
    }
  };
  return enforceResultBound(result);
}

/** <=256KB result contract: trim the frontier first, then fail closed. */
function enforceResultBound(result: Record<string, unknown>): Record<string, unknown> {
  if (trySerializeBounded(result) === "ok") return result;
  const frontier = result.frontier;
  if (Array.isArray(frontier)) {
    result.frontier = frontier.slice(0, Math.max(1, Math.floor(GA_EVOLUTION_FRONTIER_LIMIT / 2)));
    if (trySerializeBounded(result) === "ok") return result;
  }
  throw new GaEvolutionTaskError("ga_result_too_large", `GA evolution result exceeds the ${GA_EVOLUTION_RESULT_MAX_BYTES}-byte limit.`);
}

function trySerializeBounded(result: Record<string, unknown>): "ok" | "rejected" {
  try {
    serializeComputeJobResult(result, GA_EVOLUTION_RESULT_MAX_BYTES);
    return "ok";
  } catch (error) {
    if (error instanceof ComputeJobResultRejectedError) return "rejected";
    throw error;
  }
}

/** Every failure surfaced while the signal is aborted is a cancellation, not a task fault. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof MultiMarketEvalTaskError && error.code === "multi_market_eval_cancelled";
}

/** Reused multi-market-eval helpers throw their own codes; re-home them in the ga namespace. */
function mapTaskError(error: unknown): unknown {
  if (error instanceof MultiMarketEvalTaskError) {
    return new GaEvolutionTaskError(error.code.replace(/^multi_market_eval_/, "ga_"), error.message);
  }
  if (error instanceof GaEvolutionEngineError) {
    return new GaEvolutionTaskError("ga_checkpoint_invalid", error.message);
  }
  return error;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
