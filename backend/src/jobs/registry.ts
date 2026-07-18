import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1, type Candle } from "@saltanatbotv2/contracts";
import { GaEvolutionRepository, type GaEvolutionLineageStore } from "../ga/repository.js";
import { parseScreenerRunJobRequest, type ScreenerRunJobRequest } from "../screener/apiSchema.js";
import type { ScreenerRepositoryContract } from "../screener/repositoryTypes.js";
import { parseStrategyIR } from "../trading/strategy/irSchema.js";
import {
  GA_EVOLUTION_JOB_TIMEOUT_MS,
  GA_EVOLUTION_RESUME_ESTIMATED_COST,
  gaEvaluationMarkets,
  gaEvolutionRequestSchema,
  GaEvolutionTaskError,
  runGaEvolutionTask
} from "../workers/gaEvolutionTask.js";
import {
  findUnknownEvaluationMarket,
  MULTI_MARKET_EVAL_JOB_TIMEOUT_MS,
  multiMarketEvalRequestSchema,
  MultiMarketEvalTaskError,
  runMultiMarketEvalTask
} from "../workers/multiMarketEvalTask.js";
import { runScreenerTask, SCREENER_JOB_TIMEOUT_MS, ScreenerTaskError } from "../workers/screenerTask.js";

/**
 * Central research-job registry (ADR 0003 / R9.1a). Every job kind is one
 * definition object: the HTTP enqueue validation that jobs/routes.ts applies
 * and the execution mode the research worker dispatches on. The two original
 * kinds are registered here with request/response shapes and error behavior
 * unchanged; unregistered kinds keep hard-failing in both places.
 */

/** Durable enqueue parameters produced from one validated HTTP request body. */
export interface ResearchJobEnqueuePlan {
  jobType: string;
  payload: Record<string, unknown>;
  estimatedCost: number;
  clientRequestId?: string;
  dedupeKey: string;
}

export type ResearchJobEnqueueOutcome =
  | { ok: true; plan: ResearchJobEnqueuePlan }
  | { ok: false; rejection: { status: number; body: Record<string, unknown> } };

/** Outcome of an optional DB-backed enqueue gate (kind-specific quotas). */
export type ResearchJobEnqueueAuthorization =
  | { ok: true }
  | { ok: false; rejection: { status: number; body: Record<string, unknown> } };

/** Bounded, provider-routed candle access for in-process kinds (wired by the worker). */
export interface ResearchJobCandleSource {
  getCandles(request: { symbol: string; timeframe: string; limit: number; endTime?: number }, signal?: AbortSignal): Promise<Candle[]>;
}

/** CPU-heavy backtest execution through the existing worker-thread protocol. */
export interface ResearchJobBacktestRunner {
  run(task: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
}

export interface ResearchJobExecutionContext {
  ownerUserId: string;
  jobId: string;
  payload: Record<string, unknown>;
  /** Aborts on cancellation, timeout and orderly worker shutdown. */
  signal: AbortSignal;
  /** Cooperative progress report (0..1) picked up by the next lease heartbeat. */
  heartbeat: (progress: number) => void;
  logger: (event: Record<string, unknown>) => void;
  screenerPresets?: Pick<ScreenerRepositoryContract, "get">;
  candleSource?: ResearchJobCandleSource;
  backtestRunner?: ResearchJobBacktestRunner;
  gaLineage?: GaEvolutionLineageStore;
}

/** run() failures carrying a stable job error code for the owner-facing record. */
export class ResearchJobExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ResearchJobExecutionError";
  }
}

/** Screener enqueue bodies that fail validation reject as before via routes middleware. */
export class ScreenerJobRequestError extends Error {}

interface ResearchJobDefinitionBase {
  /** Job kind; equals the durable compute_jobs job_type value. */
  kind: string;
  /**
   * Validate one HTTP enqueue body into a durable plan. Thrown errors keep
   * their pre-registry meaning: ZodError and ScreenerJobRequestError map to
   * the same responses in the jobs routes error middleware as before.
   */
  parseEnqueueRequest(body: unknown): ResearchJobEnqueueOutcome;
  /**
   * Optional async gate the jobs routes apply between a successful parse and
   * the durable enqueue — for kind-specific, database-backed quotas (e.g. the
   * single active GA run per owner). Kinds without one enqueue exactly as
   * before the seam existed.
   */
  authorizeEnqueue?(input: { ownerUserId: string; pool: Pool; payload: Record<string, unknown> }): Promise<ResearchJobEnqueueAuthorization>;
}

/** Network-dependent kinds run on the research worker's main thread. */
export interface ResearchJobInProcessDefinition extends ResearchJobDefinitionBase {
  execution: "in-process";
  timeoutMs: number;
  /** Terminal code when run() throws without a ResearchJobExecutionError code. */
  failureCode: string;
  /** Public fallback message when a thrown error carries none. */
  failureMessage: string;
  run(context: ResearchJobExecutionContext): Promise<Record<string, unknown>>;
}

/** CPU-heavy kinds run inside a dedicated worker thread without network access. */
export interface ResearchJobWorkerThreadDefinition extends ResearchJobDefinitionBase {
  execution: "worker-thread";
  workerEntry: URL;
  /** Terminal code when the worker thread reports a task failure. */
  failureCode: string;
  /** Message when the worker responds with a malformed envelope. */
  invalidResponseMessage: string;
  /** Message when the worker reports a failure without a usable message. */
  failureMessage: string;
}

export type ResearchJobDefinition = ResearchJobInProcessDefinition | ResearchJobWorkerThreadDefinition;

const registry = new Map<string, ResearchJobDefinition>();

export function registerResearchJobDefinition(definition: ResearchJobDefinition): void {
  if (registry.has(definition.kind)) {
    throw new Error(`Research job kind is already registered: ${definition.kind}`);
  }
  registry.set(definition.kind, definition);
}

export function getResearchJobDefinition(kind: string): ResearchJobDefinition | undefined {
  return registry.get(kind);
}

export function listResearchJobKinds(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve the definition that validates an HTTP enqueue body. Unknown and
 * missing kinds fall through to the backtest schema so their rejection bodies
 * stay byte-identical with the pre-registry `kind` discriminator (which sent
 * every non-screener body to the backtest schema's literal check).
 */
export function resolveResearchJobEnqueueDefinition(body: unknown): ResearchJobDefinition {
  const kind =
    typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { kind?: unknown }).kind : undefined;
  const definition = typeof kind === "string" ? registry.get(kind) : undefined;
  return definition ?? requireDefinition("backtest");
}

let builtinsRegistered = false;

/** Idempotent startup registration for the built-in kinds (routes + worker). */
export function registerBuiltinResearchJobKinds(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  registerResearchJobDefinition(createScreenerJobDefinition());
  registerResearchJobDefinition(createBacktestJobDefinition());
  registerResearchJobDefinition(createMultiMarketEvalJobDefinition());
  registerResearchJobDefinition(createGaEvolutionJobDefinition());
}

function requireDefinition(kind: string): ResearchJobDefinition {
  const definition = registry.get(kind);
  if (!definition) throw new Error(`Research job kind is not registered: ${kind}`);
  return definition;
}

// --- screener: in-process (needs network), moved verbatim from jobs/routes.ts ---

const SCREENER_JOB_DEDUPE_VERSION = "screener-job:v1\0";

function createScreenerJobDefinition(): ResearchJobInProcessDefinition {
  return {
    kind: "screener",
    execution: "in-process",
    timeoutMs: SCREENER_JOB_TIMEOUT_MS,
    failureCode: "screener_failed",
    failureMessage: "Screener run failed.",
    parseEnqueueRequest(body) {
      const input = parseScreenerJobBody(body);
      const payload = { kind: "screener", request: input.request } as Record<string, unknown>;
      return {
        ok: true,
        plan: {
          jobType: "screener",
          payload,
          estimatedCost: input.request.definition?.universeLimit ?? SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1,
          clientRequestId: input.clientRequestId,
          dedupeKey: dedupeKeyFor(SCREENER_JOB_DEDUPE_VERSION, payload)
        }
      };
    },
    async run(context) {
      const presets = context.screenerPresets;
      if (!presets) {
        throw new ResearchJobExecutionError("screener_dependencies_missing", "Screener preset repository is not wired into this worker.");
      }
      try {
        return await runScreenerTask(
          { ownerUserId: context.ownerUserId, payload: context.payload, signal: context.signal },
          { presets }
        );
      } catch (error) {
        if (error instanceof ScreenerTaskError) {
          throw new ResearchJobExecutionError(error.code, error.message, { cause: error });
        }
        throw error;
      }
    }
  };
}

function parseScreenerJobBody(body: unknown): ScreenerRunJobRequest {
  try {
    return parseScreenerRunJobRequest(body);
  } catch (error) {
    throw new ScreenerJobRequestError("Invalid screener job.", { cause: error });
  }
}

// --- backtest: worker-thread (CPU-heavy, no network), moved verbatim from jobs/routes.ts ---

const BACKTEST_JOB_DEDUPE_VERSION = "backtest-job:v1\0";

const candleSchema = z.object({
  time: z.number().int().safe().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  source: z.string().max(120).optional()
}).strict().refine((candle) => candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close));

const backtestSchema = z.object({
  kind: z.literal("backtest"),
  strategy: z.unknown(),
  candles: z.array(candleSchema).min(10).max(20_000).superRefine((candles, context) => {
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index]!.time <= candles[index - 1]!.time) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Candle timestamps must be strictly increasing.",
          path: [index, "time"]
        });
        return;
      }
    }
  }),
  config: z.object({
    initialCapital: z.number().finite().min(100).max(1_000_000_000),
    commissionPct: z.number().finite().min(0).max(10),
    slippagePct: z.number().finite().min(0).max(10),
    allowShort: z.boolean(),
    fillTiming: z.enum(["next_open", "same_close"]).optional(),
    maxLeverage: z.number().finite().min(1).max(125).optional(),
    qtyStep: z.number().finite().min(0).optional(),
    fundingRatePctPer8h: z.number().finite().min(-100).max(100).optional()
  }).strict(),
  context: z.object({
    symbol: z.string().min(1).max(40).optional(),
    timeframe: z.string().min(1).max(16).optional(),
    exchange: z.string().min(1).max(40).optional(),
    marketType: z.enum(["spot", "linear", "inverse", "unknown"]).optional(),
    priceType: z.enum(["trade", "mark", "index", "unknown"]).optional()
  }).strict().optional(),
  clientRequestId: z.string().min(8).max(128).optional()
}).strict();

function createBacktestJobDefinition(): ResearchJobWorkerThreadDefinition {
  return {
    kind: "backtest",
    execution: "worker-thread",
    workerEntry: new URL("../workers/backtestTask.js", import.meta.url),
    failureCode: "backtest_failed",
    invalidResponseMessage: "Backtest worker returned an invalid response.",
    failureMessage: "Backtest failed.",
    parseEnqueueRequest(body) {
      const input = backtestSchema.parse(body);
      const parsedIr = parseStrategyIR(input.strategy);
      if (!parsedIr.ok) {
        return {
          ok: false,
          rejection: { status: 400, body: { error: `Invalid strategy: ${parsedIr.error}`, code: "invalid_strategy" } }
        };
      }
      const { clientRequestId, ...jobInput } = input;
      const payload = { ...jobInput, strategy: parsedIr.ir } as Record<string, unknown>;
      return {
        ok: true,
        plan: {
          jobType: "backtest",
          payload,
          estimatedCost: input.candles.length,
          clientRequestId,
          dedupeKey: dedupeKeyFor(BACKTEST_JOB_DEDUPE_VERSION, payload)
        }
      };
    }
  };
}

// --- multi-market-eval: in-process fetch + worker-thread backtests (R9.1b) ---

const MULTI_MARKET_EVAL_JOB_DEDUPE_VERSION = "multi-market-eval-job:v1\0";

function createMultiMarketEvalJobDefinition(): ResearchJobInProcessDefinition {
  return {
    kind: "multi-market-eval",
    execution: "in-process",
    timeoutMs: MULTI_MARKET_EVAL_JOB_TIMEOUT_MS,
    failureCode: "multi_market_eval_failed",
    failureMessage: "Multi-market evaluation failed.",
    parseEnqueueRequest(body) {
      const input = multiMarketEvalRequestSchema.parse(body);
      const parsedIr = parseStrategyIR(input.ir);
      if (!parsedIr.ok) {
        return {
          ok: false,
          rejection: { status: 400, body: { error: `Invalid strategy: ${parsedIr.error}`, code: "invalid_strategy" } }
        };
      }
      const unknownMarket = findUnknownEvaluationMarket(input.markets);
      if (unknownMarket) {
        return {
          ok: false,
          rejection: {
            status: 400,
            body: { error: `Market ${unknownMarket} is not available for server evaluation.`, code: "unknown_market" }
          }
        };
      }
      const payload = {
        kind: "multi-market-eval",
        strategy: parsedIr.ir,
        markets: input.markets,
        lookbackBars: input.lookbackBars,
        split: input.split,
        seed: input.seed
      } as Record<string, unknown>;
      return {
        ok: true,
        plan: {
          jobType: "multi-market-eval",
          payload,
          estimatedCost: input.lookbackBars * input.markets.length,
          clientRequestId: input.clientRequestId,
          dedupeKey: dedupeKeyFor(MULTI_MARKET_EVAL_JOB_DEDUPE_VERSION, payload)
        }
      };
    },
    async run(context) {
      try {
        return await runMultiMarketEvalTask(
          { ownerUserId: context.ownerUserId, payload: context.payload, signal: context.signal, heartbeat: context.heartbeat },
          {
            ...(context.candleSource ? { candleSource: context.candleSource } : {}),
            ...(context.backtestRunner ? { backtestRunner: context.backtestRunner } : {})
          }
        );
      } catch (error) {
        if (error instanceof MultiMarketEvalTaskError) {
          throw new ResearchJobExecutionError(error.code, error.message, { cause: error });
        }
        throw error;
      }
    }
  };
}

// --- ga-evolution: in-process seeded evolution with checkpointed lineage (R9.2) ---

const GA_EVOLUTION_JOB_DEDUPE_VERSION = "ga-evolution-job:v1\0";

function createGaEvolutionJobDefinition(): ResearchJobInProcessDefinition {
  return {
    kind: "ga-evolution",
    execution: "in-process",
    timeoutMs: GA_EVOLUTION_JOB_TIMEOUT_MS,
    failureCode: "ga_evolution_failed",
    failureMessage: "GA evolution run failed.",
    parseEnqueueRequest(body) {
      const input = gaEvolutionRequestSchema.parse(body);
      let payload: Record<string, unknown>;
      let estimatedCost: number;
      if (input.mode === "start") {
        const unknownMarket = findUnknownEvaluationMarket(gaEvaluationMarkets(input.config));
        if (unknownMarket) {
          return {
            ok: false,
            rejection: {
              status: 400,
              body: { error: `Market ${unknownMarket} is not available for server evolution.`, code: "unknown_market" }
            }
          };
        }
        payload = { kind: "ga-evolution", mode: "start", config: input.config };
        estimatedCost = input.config.lookbackBars * input.config.markets.length * input.config.generations;
      } else {
        payload = { kind: "ga-evolution", mode: "resume", runId: input.runId };
        estimatedCost = GA_EVOLUTION_RESUME_ESTIMATED_COST;
      }
      return {
        ok: true,
        plan: {
          jobType: "ga-evolution",
          payload,
          estimatedCost,
          ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}),
          dedupeKey: dedupeKeyFor(GA_EVOLUTION_JOB_DEDUPE_VERSION, payload)
        }
      };
    },
    /** Spec §3 quota: at most one active GA run per owner, checked against ga_runs. */
    async authorizeEnqueue({ ownerUserId, pool, payload }) {
      const lineage = new GaEvolutionRepository(pool);
      await lineage.failOrphanedRuns(ownerUserId);
      if (await lineage.hasActiveRun(ownerUserId)) {
        return {
          ok: false,
          rejection: { status: 429, body: { error: "Another GA evolution run is already active for this owner.", code: "ga_run_active" } }
        };
      }
      if (payload.mode === "resume" && typeof payload.runId === "string") {
        const run = await lineage.getRun(ownerUserId, payload.runId);
        if (!run) {
          return { ok: false, rejection: { status: 404, body: { error: "GA run not found.", code: "ga_run_not_found" } } };
        }
        if (run.status !== "checkpointed") {
          return {
            ok: false,
            rejection: { status: 409, body: { error: `GA run is ${run.status} and cannot be resumed.`, code: "ga_run_not_resumable" } }
          };
        }
      }
      return { ok: true };
    },
    async run(context) {
      const lineage = context.gaLineage;
      if (!lineage) {
        throw new ResearchJobExecutionError("ga_dependencies_missing", "GA lineage repository is not wired into this worker.");
      }
      try {
        return await runGaEvolutionTask(
          {
            ownerUserId: context.ownerUserId,
            jobId: context.jobId,
            payload: context.payload,
            signal: context.signal,
            heartbeat: context.heartbeat
          },
          {
            lineage,
            ...(context.candleSource ? { candleSource: context.candleSource } : {}),
            ...(context.backtestRunner ? { backtestRunner: context.backtestRunner } : {})
          }
        );
      } catch (error) {
        if (error instanceof GaEvolutionTaskError) {
          throw new ResearchJobExecutionError(error.code, error.message, { cause: error });
        }
        throw error;
      }
    }
  };
}

function dedupeKeyFor(version: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(version, "utf8").update(JSON.stringify(payload), "utf8").digest("hex");
}
