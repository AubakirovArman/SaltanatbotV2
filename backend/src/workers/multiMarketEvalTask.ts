import {
  BACKTEST_ENGINE_VERSION,
  buildDatasetDescriptor,
  DATASET_EMBARGO_BARS_MAXIMUM,
  DATASET_TRAIN_FRACTION_MAXIMUM,
  DATASET_TRAIN_FRACTION_MINIMUM,
  DatasetContractError,
  DEFAULT_BACKTEST_CONFIG,
  simulatePortfolioBacktest,
  splitDatasetBars,
  type BacktestResult,
  type DatasetDescriptorV1,
  type PortfolioBacktestResult,
  type PortfolioRejectionReason
} from "@saltanatbotv2/backtest-core";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import { z } from "zod";
import { candleHasFiniteMarketShape } from "../alerts/priceEvaluator.js";
import { ComputeJobResultRejectedError, serializeComputeJobResult } from "../jobs/resultPayload.js";
import { findInstrument, initCatalog } from "../market/catalog.js";
import { timeframes } from "../market/timeframes.js";
import { ProviderRouter } from "../providers/router.js";
import { parseStrategyIR } from "../trading/strategy/irSchema.js";
import type { Candle, Timeframe } from "../types.js";
import { createBacktestThreadRunner } from "./backtestThreadRunner.js";

/**
 * In-process "multi-market-eval" job executor (ADR 0003 / R9.1b): fetch REAL
 * closed bars per market through the strict provider route (screener budget
 * discipline, NO synthetic fills — a market that cannot supply enough real
 * bars fails the whole job with an explicit reason), pin the dataset with a
 * `dataset-v1` descriptor + fingerprint, split train/test with an embargo gap,
 * run per-market backtests through the existing backtestTask worker-thread
 * protocol and aggregate an out-of-sample shared-capital portfolio section.
 * Deterministic: identical candles + IR + config produce an identical result;
 * the seed is recorded for provenance only.
 */

export const MULTI_MARKET_EVAL_JOB_TIMEOUT_MS = 180_000;
export const MULTI_MARKET_EVAL_SCHEMA_VERSION = "multi-market-eval-v1";
export const MULTI_MARKET_EVAL_RESULT_MAX_BYTES = 256 * 1024;
export const MULTI_MARKET_EVAL_FETCH_BUDGET_MS = 90_000;
export const MULTI_MARKET_EVAL_CANDLE_CONCURRENCY = 3;
export const MULTI_MARKET_EVAL_MARKETS_MAXIMUM = 6;
export const MULTI_MARKET_EVAL_LOOKBACK_MINIMUM = 500;
export const MULTI_MARKET_EVAL_LOOKBACK_MAXIMUM = 20_000;
export const MULTI_MARKET_EVAL_INITIAL_CAPITAL = 10_000;
/** Router source key for strict Binance spot last-price candles. */
export const MULTI_MARKET_EVAL_DATASET_SOURCE = "binance:spot:last";
/** Backtest worker minimum window; split windows below it cannot be evaluated. */
const BACKTEST_WINDOW_MINIMUM_BARS = 10;
const PROVIDER_PAGE_LIMIT = 1_000;

export class MultiMarketEvalTaskError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MultiMarketEvalTaskError";
  }
}

class EvalBudgetExhaustedError extends Error {}

const evalMarketSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,40}$/, "Symbol must be an uppercase exchange symbol."),
  timeframe: z.string().refine((value) => (timeframes as readonly string[]).includes(value), "Unsupported timeframe.")
}).strict();

const evalMarketsSchema = z.array(evalMarketSchema).min(1).max(MULTI_MARKET_EVAL_MARKETS_MAXIMUM).superRefine((markets, context) => {
  const seen = new Set<string>();
  for (let index = 0; index < markets.length; index += 1) {
    const market = markets[index]!;
    if (seen.has(market.symbol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Market symbols must be unique.", path: [index, "symbol"] });
    }
    seen.add(market.symbol);
    if (market.timeframe !== markets[0]!.timeframe) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "All markets must share one timeframe: dataset-v1 pins a single timeframe per evaluation dataset.",
        path: [index, "timeframe"]
      });
    }
  }
});

const evalSplitFields = {
  trainFraction: z.number().finite().min(DATASET_TRAIN_FRACTION_MINIMUM).max(DATASET_TRAIN_FRACTION_MAXIMUM),
  embargoBars: z.number().int().min(0).max(DATASET_EMBARGO_BARS_MAXIMUM)
};

const evalLookbackSchema = z.number().int().min(MULTI_MARKET_EVAL_LOOKBACK_MINIMUM).max(MULTI_MARKET_EVAL_LOOKBACK_MAXIMUM);
const evalSeedSchema = z.number().int().safe().nonnegative();

/** HTTP enqueue body (spec §3): strict, bounded, IR validated by the registry. */
export const multiMarketEvalRequestSchema = z.object({
  kind: z.literal("multi-market-eval"),
  ir: z.unknown(),
  markets: evalMarketsSchema,
  lookbackBars: evalLookbackSchema,
  split: z.object({
    trainFraction: evalSplitFields.trainFraction.default(0.7),
    embargoBars: evalSplitFields.embargoBars.default(8)
  }).strict().default({ trainFraction: 0.7, embargoBars: 8 }),
  seed: evalSeedSchema,
  clientRequestId: z.string().min(8).max(128).optional()
}).strict();

/** Durable payload shape re-validated at execution time (defaults resolved). */
const multiMarketEvalPayloadSchema = z.object({
  kind: z.literal("multi-market-eval"),
  strategy: z.unknown(),
  markets: evalMarketsSchema,
  lookbackBars: evalLookbackSchema,
  split: z.object(evalSplitFields).strict(),
  seed: evalSeedSchema
}).strict();

export interface MultiMarketEvalMarket {
  symbol: string;
  timeframe: string;
}

/** Train/test split settings shared by every dataset-v1 consumer of these helpers. */
export interface MultiMarketEvalSplit {
  trainFraction: number;
  embargoBars: number;
}

/**
 * Catalog gate for the enqueue boundary: every requested market must be in the
 * current public instrument catalog AND routed to a real exchange feed —
 * synthetic-only instruments can never satisfy the real-bars contract. Returns
 * the first offending symbol, or undefined when all markets are evaluable.
 */
export function findUnknownEvaluationMarket(markets: readonly MultiMarketEvalMarket[]): string | undefined {
  for (const market of markets) {
    const instrument = findInstrument(market.symbol);
    if (!instrument || instrument.provider !== "binance") return market.symbol;
  }
  return undefined;
}

/** Bounded provider-routed candle access; the worker-side default resolves via catalog. */
export interface MultiMarketEvalCandleSource {
  getCandles(request: { symbol: string; timeframe: string; limit: number; endTime?: number }, signal?: AbortSignal): Promise<Candle[]>;
}

export interface MultiMarketEvalBacktestRunner {
  run(task: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
}

export interface MultiMarketEvalTaskInput {
  ownerUserId: string;
  payload: unknown;
  signal?: AbortSignal;
  heartbeat?: (progress: number) => void;
}

export interface MultiMarketEvalTaskDependencies {
  candleSource?: MultiMarketEvalCandleSource;
  backtestRunner?: MultiMarketEvalBacktestRunner;
  now?: () => number;
  fetchBudgetMs?: number;
  concurrency?: number;
  backtestTimeoutMs?: number;
}

interface MultiMarketEvalRequest {
  strategy: StrategyIR;
  markets: MultiMarketEvalMarket[];
  lookbackBars: number;
  split: { trainFraction: number; embargoBars: number };
  seed: number;
}

export async function runMultiMarketEvalTask(
  input: MultiMarketEvalTaskInput,
  dependencies: MultiMarketEvalTaskDependencies = {}
): Promise<Record<string, unknown>> {
  const heartbeat = input.heartbeat ?? (() => undefined);
  const request = parseMultiMarketEvalPayload(input.payload);
  const candleSource = dependencies.candleSource ?? createCatalogCandleSource();
  const backtestRunner = dependencies.backtestRunner ?? createBacktestThreadRunner();
  const timeframe = request.markets[0]!.timeframe;
  heartbeat(0.05);

  const barsBySymbol = await fetchAllMarketBars(request, candleSource, dependencies, input.signal, heartbeat);
  const dataset = buildEvalDataset(request, timeframe, barsBySymbol);
  const windows = splitAllMarkets(request, barsBySymbol);
  heartbeat(0.45);

  const totalRuns = request.markets.length * 2;
  let completedRuns = 0;
  const noteRun = () => {
    completedRuns += 1;
    heartbeat(0.45 + 0.45 * (completedRuns / totalRuns));
  };
  const markets: Record<string, unknown>[] = [];
  const outOfSampleLegs: { symbol: string; candles: Candle[]; report: BacktestResult }[] = [];
  for (const market of request.markets) {
    const window = windows.get(market.symbol)!;
    // Cancellation is honored between backtests, not just between markets.
    throwIfCancelled(input.signal);
    const trainReport = await runWindowBacktest(backtestRunner, request.strategy, market, window.train, dependencies, input.signal);
    noteRun();
    throwIfCancelled(input.signal);
    const testReport = await runWindowBacktest(backtestRunner, request.strategy, market, window.test, dependencies, input.signal);
    noteRun();
    markets.push({
      symbol: market.symbol,
      timeframe: market.timeframe,
      train: evaluationSection(market.symbol, trainReport, window.train.length),
      outOfSample: evaluationSection(market.symbol, testReport, window.test.length)
    });
    outOfSampleLegs.push({ symbol: market.symbol, candles: window.test, report: portfolioLegReport(market.symbol, testReport) });
  }

  throwIfCancelled(input.signal);
  const portfolio = compactPortfolioSection(
    simulatePortfolioBacktest(outOfSampleLegs, { initialCapital: MULTI_MARKET_EVAL_INITIAL_CAPITAL })
  );
  const result: Record<string, unknown> = {
    schemaVersion: MULTI_MARKET_EVAL_SCHEMA_VERSION,
    engineVersion: BACKTEST_ENGINE_VERSION,
    dataset,
    seed: request.seed,
    markets,
    portfolio
  };
  heartbeat(0.98);
  return enforceResultBound(result);
}

function parseMultiMarketEvalPayload(payload: unknown): MultiMarketEvalRequest {
  const parsed = multiMarketEvalPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    throw new MultiMarketEvalTaskError("multi_market_eval_payload_invalid", `Multi-market evaluation payload is invalid: ${detail}`);
  }
  // parseStrategyIR stays the ONLY trust boundary for inbound IR (ADR 0003) —
  // the durable payload is re-checked here even though enqueue validated it.
  const ir = parseStrategyIR(parsed.data.strategy);
  if (!ir.ok) {
    throw new MultiMarketEvalTaskError("multi_market_eval_payload_invalid", `Multi-market evaluation strategy is invalid: ${ir.error}`);
  }
  return {
    strategy: ir.ir,
    markets: parsed.data.markets,
    lookbackBars: parsed.data.lookbackBars,
    split: parsed.data.split,
    seed: parsed.data.seed
  };
}

/** Default candle source: shared catalog + strict provider route (no synthetic fallback). */
export function createCatalogCandleSource(router: Pick<ProviderRouter, "getCandles"> = new ProviderRouter()): MultiMarketEvalCandleSource {
  return {
    async getCandles(request, signal) {
      await initCatalog();
      throwIfCancelled(signal);
      const instrument = findInstrument(request.symbol);
      if (!instrument || instrument.provider !== "binance") {
        throw new MultiMarketEvalTaskError(
          "multi_market_eval_market_unknown",
          `Market ${request.symbol} is not available in the public instrument catalog with real exchange data.`
        );
      }
      return router.getCandles(
        instrument,
        request.timeframe as Timeframe,
        { limit: request.limit, ...(request.endTime !== undefined ? { endTime: request.endTime } : {}) },
        { exchange: "binance", marketType: "spot", priceType: "last", strict: true }
      );
    }
  };
}

/**
 * Screener budget discipline, fail-closed variant: one shared wall-clock
 * budget and a small worker pool over the markets, but any market that cannot
 * deliver its full real closed window fails the whole evaluation (the
 * screener degrades per symbol; dataset-v1 forbids partial or synthetic data).
 * Exported for reuse by the ga-evolution executor (R9.2), which fetches its
 * dataset once per run through exactly this discipline.
 */
export async function fetchAllMarketBars(
  request: { markets: readonly MultiMarketEvalMarket[]; lookbackBars: number },
  source: MultiMarketEvalCandleSource,
  dependencies: MultiMarketEvalTaskDependencies,
  signal: AbortSignal | undefined,
  heartbeat: (progress: number) => void
): Promise<Map<string, Candle[]>> {
  const now = dependencies.now ?? Date.now;
  const deadlineAt = now() + (dependencies.fetchBudgetMs ?? MULTI_MARKET_EVAL_FETCH_BUDGET_MS);
  const remainingMs = () => deadlineAt - now();
  const concurrency = Math.max(1, Math.min(dependencies.concurrency ?? MULTI_MARKET_EVAL_CANDLE_CONCURRENCY, request.markets.length));
  const barsBySymbol = new Map<string, Candle[]>();
  let cursor = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < request.markets.length) {
      const market = request.markets[cursor]!;
      cursor += 1;
      barsBySymbol.set(market.symbol, await fetchMarketBars(market, request.lookbackBars, source, signal, remainingMs));
      completed += 1;
      heartbeat(0.05 + 0.4 * (completed / request.markets.length));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return barsBySymbol;
}

/** Page backwards through provider history until the full lookback window is real and closed. */
async function fetchMarketBars(
  market: MultiMarketEvalMarket,
  lookbackBars: number,
  source: MultiMarketEvalCandleSource,
  signal: AbortSignal | undefined,
  remainingMs: () => number
): Promise<Candle[]> {
  const bars: Candle[] = [];
  let endTime: number | undefined;
  for (;;) {
    throwIfCancelled(signal);
    const missing = lookbackBars - bars.length;
    if (missing <= 0) break;
    const budget = remainingMs();
    if (budget <= 0) throw budgetExhausted(market.symbol);
    // The tip page may return the forming bar, so over-request by one there.
    const limit = Math.min(PROVIDER_PAGE_LIMIT, missing + (endTime === undefined ? 1 : 0));
    let page: Candle[];
    try {
      page = await withDeadline(
        source.getCandles({ symbol: market.symbol, timeframe: market.timeframe, limit, ...(endTime !== undefined ? { endTime } : {}) }, signal),
        budget
      );
    } catch (error) {
      if (error instanceof MultiMarketEvalTaskError) throw error;
      if (error instanceof EvalBudgetExhaustedError) throw budgetExhausted(market.symbol);
      throw new MultiMarketEvalTaskError(
        "multi_market_eval_market_data_unavailable",
        `Market ${market.symbol} data is unavailable: ${errorMessage(error)}`
      );
    }
    const closed = endTime === undefined ? dropFormingTip(page) : page;
    const headTime = bars[0]?.time ?? Number.POSITIVE_INFINITY;
    const older = closed.filter((candle) => candle.time < headTime);
    if (older.length === 0) break; // History exhausted: nothing older exists upstream.
    bars.unshift(...older);
    endTime = bars[0]!.time - 1;
  }
  if (bars.length < lookbackBars) {
    throw new MultiMarketEvalTaskError(
      "multi_market_eval_market_bars_insufficient",
      `Market ${market.symbol} supplied ${bars.length} of the ${lookbackBars} closed real bars this evaluation requires; synthetic fills are not allowed.`
    );
  }
  const window = bars.slice(bars.length - lookbackBars);
  assertRealClosedWindow(market.symbol, window);
  return window;
}

/** Providers return the forming bar as the tip; only fully closed bars may be evaluated. */
function dropFormingTip(candles: readonly Candle[]): Candle[] {
  const closed = [...candles];
  while (closed.length > 0 && closed[closed.length - 1]!.final !== true) closed.pop();
  return closed;
}

/** REAL bars only (provenance real): finite geometry, closed, never fallback-sourced. */
function assertRealClosedWindow(symbol: string, bars: readonly Candle[]): void {
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (!candleHasFiniteMarketShape(bar)) {
      throw new MultiMarketEvalTaskError("multi_market_eval_market_bars_invalid", `Market ${symbol} returned a malformed bar at index ${index}.`);
    }
    if (bar.final !== true) {
      throw new MultiMarketEvalTaskError("multi_market_eval_market_bars_invalid", `Market ${symbol} returned a non-final bar at index ${index}; only closed bars may be evaluated.`);
    }
    if (typeof bar.source === "string" && bar.source.startsWith("Fallback")) {
      throw new MultiMarketEvalTaskError(
        "multi_market_eval_market_bars_not_real",
        `Market ${symbol} returned synthetic fallback bars; server evaluation requires real exchange data.`
      );
    }
    if (index > 0 && bar.time <= bars[index - 1]!.time) {
      throw new MultiMarketEvalTaskError("multi_market_eval_market_bars_invalid", `Market ${symbol} returned non-increasing bar timestamps at index ${index}.`);
    }
  }
}

export function buildEvalDataset(request: { split: MultiMarketEvalSplit }, timeframe: string, barsBySymbol: Map<string, Candle[]>): DatasetDescriptorV1 {
  try {
    return buildDatasetDescriptor({
      source: MULTI_MARKET_EVAL_DATASET_SOURCE,
      timeframe,
      barsBySymbol,
      split: request.split
    });
  } catch (error) {
    if (error instanceof DatasetContractError) {
      throw new MultiMarketEvalTaskError("multi_market_eval_dataset_invalid", `Evaluation dataset violates dataset-v1: ${error.message}`);
    }
    throw error;
  }
}

export function splitAllMarkets(request: { markets: readonly MultiMarketEvalMarket[]; split: MultiMarketEvalSplit }, barsBySymbol: Map<string, Candle[]>): Map<string, { train: Candle[]; test: Candle[] }> {
  const windows = new Map<string, { train: Candle[]; test: Candle[] }>();
  for (const market of request.markets) {
    let split: { train: Candle[]; test: Candle[] };
    try {
      split = splitDatasetBars(barsBySymbol.get(market.symbol) ?? [], request.split);
    } catch (error) {
      if (error instanceof DatasetContractError) {
        throw new MultiMarketEvalTaskError(
          "multi_market_eval_market_bars_insufficient",
          `Market ${market.symbol} cannot satisfy the requested train/test split: ${error.message}`
        );
      }
      throw error;
    }
    if (split.train.length < BACKTEST_WINDOW_MINIMUM_BARS || split.test.length < BACKTEST_WINDOW_MINIMUM_BARS) {
      throw new MultiMarketEvalTaskError(
        "multi_market_eval_market_bars_insufficient",
        `Market ${market.symbol} split windows are too small to backtest (train ${split.train.length}, test ${split.test.length}, minimum ${BACKTEST_WINDOW_MINIMUM_BARS}).`
      );
    }
    windows.set(market.symbol, split);
  }
  return windows;
}

export async function runWindowBacktest(
  runner: MultiMarketEvalBacktestRunner,
  strategy: StrategyIR,
  market: MultiMarketEvalMarket,
  candles: Candle[],
  dependencies: Pick<MultiMarketEvalTaskDependencies, "backtestTimeoutMs">,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const task: Record<string, unknown> = {
    strategy: strategy as unknown as Record<string, unknown>,
    candles,
    // Deterministic fixed execution settings: engine defaults with the shared
    // 10 000-quote evaluation capital. No wall clock, no unseeded randomness.
    config: { ...DEFAULT_BACKTEST_CONFIG, initialCapital: MULTI_MARKET_EVAL_INITIAL_CAPITAL },
    context: { symbol: market.symbol, timeframe: market.timeframe, exchange: "binance", marketType: "spot", priceType: "trade" }
  };
  try {
    return await runner.run(task, {
      ...(signal ? { signal } : {}),
      ...(dependencies.backtestTimeoutMs !== undefined ? { timeoutMs: dependencies.backtestTimeoutMs } : {})
    });
  } catch (error) {
    throwIfCancelled(signal);
    throw new MultiMarketEvalTaskError("multi_market_eval_backtest_failed", `Backtest for ${market.symbol} failed: ${errorMessage(error)}`);
  }
}

/** Per-window section: computeBacktestMetrics output (spread) + barCount + tradeCount. */
export function evaluationSection(symbol: string, report: Record<string, unknown>, barCount: number): Record<string, unknown> {
  const metrics = report.metrics;
  if (!isRecord(metrics)) {
    throw new MultiMarketEvalTaskError("multi_market_eval_backtest_invalid_response", `Backtest for ${symbol} returned a report without metrics.`);
  }
  const totalTrades = metrics.totalTrades;
  const tradeCount = typeof totalTrades === "number" ? totalTrades : Array.isArray(report.trades) ? report.trades.length : 0;
  return { ...metrics, barCount, tradeCount };
}

/**
 * Rehydrate the compact worker report into the leg shape the portfolio
 * simulator reads (name, trades, metadata.config, executionTrace). Funding
 * events are empty by construction: the evaluation config pins
 * fundingRatePctPer8h to 0, so no funding is ever charged.
 */
export function portfolioLegReport(symbol: string, report: Record<string, unknown>): BacktestResult {
  const trades = report.trades;
  const metadata = report.metadata;
  if (!Array.isArray(trades) || !isRecord(metadata) || !isRecord(metadata.config)) {
    throw new MultiMarketEvalTaskError("multi_market_eval_backtest_invalid_response", `Backtest for ${symbol} returned an invalid report.`);
  }
  return {
    name: typeof report.name === "string" ? report.name : "Strategy",
    trades,
    metadata,
    executionTrace: { events: [] }
  } as unknown as BacktestResult;
}

/**
 * Bounded portfolio section for the OOS shared-capital run: metrics (incl.
 * maxDrawdownPct and sharpe), correlation matrix, per-symbol contributions and
 * rejection counts — never the full equity curve or trade list.
 */
export function compactPortfolioSection(result: PortfolioBacktestResult): Record<string, unknown> {
  const rejectionCounts: Record<PortfolioRejectionReason, number> = {
    max_concurrent: 0,
    gross_exposure: 0,
    allocation_too_small: 0,
    invalid_candidate: 0
  };
  for (const entry of result.rejectedEntries) rejectionCounts[entry.reason] += 1;
  return {
    config: { ...result.config },
    symbols: result.symbols,
    commonRange: { ...result.commonRange },
    metrics: result.metrics,
    correlation: result.correlation,
    contributions: result.contributions,
    rejectionCounts
  };
}

/** ≤256KB result contract: trim the correlation matrix first, then fail closed. */
function enforceResultBound(result: Record<string, unknown>): Record<string, unknown> {
  const first = trySerializeBounded(result);
  if (first === "ok") return result;
  if (first === "too_large") {
    const portfolio = result.portfolio;
    if (isRecord(portfolio)) {
      const correlation = portfolio.correlation;
      portfolio.correlation = {
        symbols: isRecord(correlation) && Array.isArray(correlation.symbols) ? correlation.symbols : [],
        values: [],
        averagePairwise: isRecord(correlation) && typeof correlation.averagePairwise === "number" ? correlation.averagePairwise : null,
        trimmed: true
      };
      if (trySerializeBounded(result) === "ok") return result;
    }
    throw new MultiMarketEvalTaskError(
      "multi_market_eval_result_too_large",
      `Multi-market evaluation result exceeds the ${MULTI_MARKET_EVAL_RESULT_MAX_BYTES}-byte limit.`
    );
  }
  throw new MultiMarketEvalTaskError("multi_market_eval_result_not_serializable", "Multi-market evaluation result is not JSON-serializable.");
}

function trySerializeBounded(result: Record<string, unknown>): "ok" | "too_large" | "not_serializable" {
  try {
    serializeComputeJobResult(result, MULTI_MARKET_EVAL_RESULT_MAX_BYTES);
    return "ok";
  } catch (error) {
    if (error instanceof ComputeJobResultRejectedError) {
      return error.code === "result_too_large" ? "too_large" : "not_serializable";
    }
    throw error;
  }
}

function budgetExhausted(symbol: string): MultiMarketEvalTaskError {
  return new MultiMarketEvalTaskError(
    "multi_market_eval_budget_exhausted",
    `Market ${symbol} could not supply its candle window within the ${MULTI_MARKET_EVAL_FETCH_BUDGET_MS}ms evaluation budget.`
  );
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MultiMarketEvalTaskError("multi_market_eval_cancelled", "Multi-market evaluation was cancelled.");
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EvalBudgetExhaustedError("Evaluation fetch budget exhausted.")), timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 4_000) : "unknown error";
}
