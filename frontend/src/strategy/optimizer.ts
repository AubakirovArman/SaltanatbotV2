import type { Candle } from "../types";
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig, type BacktestMetrics, type BacktestResult } from "./backtest";
import type { StrategyIR } from "./ir";

/**
 * Parameter optimizer with in-sample / out-of-sample separation and rolling
 * walk-forward. Everything here is PURE and deterministic: no Date.now, no
 * Math.random. Random-search uses a seeded mulberry32 (mirrors montecarlo.ts).
 *
 * The optimizer sweeps a strategy's named numeric `inputs` (StrategyIR.inputs),
 * runs the existing `runBacktest` on an IN-SAMPLE slice to rank combos, then
 * re-runs the BEST combo on the held-out OUT-OF-SAMPLE slice. A combo that only
 * shines in-sample and collapses out-of-sample is curve-fit — the split exposes
 * that instead of hiding it.
 */

/** mulberry32 — same seeded PRNG family used by montecarlo.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Objective the search maximises. */
export type Objective = "netProfit" | "sharpe" | "profitFactor" | "returnOverDd";

/** One parameter's sweep: an explicit value list, or a min/max/step range. */
export interface ParamSpec {
  /** Name of a StrategyIR input to override. */
  name: string;
  /** Explicit values to try (takes priority over min/max/step when present). */
  values?: number[];
  min?: number;
  max?: number;
  step?: number;
}

export interface OptimizeSpec {
  /** 1..3 parameters to sweep (the UI enforces the 1–3 cap; the core does not). */
  params: ParamSpec[];
  objective: Objective;
  /** Fraction of candles used for the in-sample optimisation window (0..1). */
  trainFrac?: number;
  /** Max grid combinations to evaluate before truncating (default 2000). */
  maxCombos?: number;
  /**
   * When the full grid exceeds `maxCombos`, sample this many random combos
   * instead of truncating in index order — seeded, so still deterministic.
   * When 'grid' (default) the first `maxCombos` combos are taken in order.
   */
  searchMode?: "grid" | "random";
  /** Seed for random-search sampling. */
  seed?: number;
}

/** A concrete assignment of swept input names → values. */
export type ParamCombo = Record<string, number>;

export interface ComboResult {
  params: ParamCombo;
  /** In-sample objective score (higher is better). */
  score: number;
  inSample: BacktestMetrics;
  /** Out-of-sample metrics — only populated for the ranked winner(s) we re-tested. */
  outSample?: BacktestMetrics;
  outScore?: number;
}

export interface OptimizeResult {
  ranked: ComboResult[];
  best?: ComboResult;
  /** Total combos in the full cartesian grid. */
  totalCombos: number;
  /** Combos actually evaluated (== totalCombos unless truncated/sampled). */
  evaluated: number;
  truncated: boolean;
  objective: Objective;
  trainFrac: number;
  /** Index at which candles were split into in-sample / out-of-sample. */
  splitIndex: number;
  /** Full backtest of the winning combo on the OUT-OF-SAMPLE slice (for rendering). */
  bestOutSampleRun?: BacktestResult;
}

const DEFAULT_MAX_COMBOS = 2000;
const DEFAULT_TRAIN_FRAC = 0.7;

/** Enumerate the value list for one parameter spec. */
export function expandParam(spec: ParamSpec): number[] {
  if (spec.values && spec.values.length) return dedupe(spec.values);
  const min = spec.min ?? 0;
  const max = spec.max ?? min;
  const step = spec.step && spec.step > 0 ? spec.step : 1;
  if (max < min) return [min];
  const out: number[] = [];
  // Guard against runaway ranges: cap at 10000 raw points per axis.
  for (let v = min, i = 0; v <= max + 1e-9 && i < 10_000; v += step, i += 1) {
    out.push(round12(v));
  }
  return dedupe(out.length ? out : [min]);
}

function dedupe(values: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of values) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** Round to 12 significant places to avoid float drift accumulating in a range. */
function round12(v: number): number {
  return Number.parseFloat(v.toPrecision(12));
}

/** Full cartesian product of every parameter's value list. */
function cartesian(axes: { name: string; values: number[] }[]): ParamCombo[] {
  let combos: ParamCombo[] = [{}];
  for (const axis of axes) {
    const next: ParamCombo[] = [];
    for (const combo of combos) {
      for (const value of axis.values) next.push({ ...combo, [axis.name]: value });
    }
    combos = next;
  }
  return combos;
}

/** Clone the IR overriding the named numeric inputs with the combo's values. */
export function cloneWithInputs(ir: StrategyIR, combo: ParamCombo): StrategyIR {
  return {
    ...ir,
    inputs: ir.inputs.map((input) => (input.name in combo ? { ...input, value: combo[input.name] } : { ...input }))
  };
}

/** Score a completed backtest by the chosen objective (higher = better). */
export function scoreMetrics(metrics: BacktestMetrics, objective: Objective): number {
  switch (objective) {
    case "netProfit":
      return metrics.netProfit;
    case "sharpe":
      return Number.isFinite(metrics.sharpe) ? metrics.sharpe : -Infinity;
    case "profitFactor":
      // Infinite PF (no losses) is real but unrankable — clamp to a large finite.
      return Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : (metrics.netProfit > 0 ? 1e6 : 0);
    case "returnOverDd":
      // Net profit per unit of max drawdown; reward positive edge with tiny DD.
      return metrics.maxDrawdown > 0 ? metrics.netProfit / metrics.maxDrawdown : (metrics.netProfit > 0 ? metrics.netProfit : 0);
  }
}

/** Slice candles into an in-sample / out-of-sample pair at `trainFrac`. */
function splitCandles(candles: Candle[], trainFrac: number): { train: Candle[]; test: Candle[]; splitIndex: number } {
  const frac = Math.min(0.95, Math.max(0.05, trainFrac));
  const splitIndex = Math.max(1, Math.min(candles.length - 1, Math.floor(candles.length * frac)));
  return { train: candles.slice(0, splitIndex), test: candles.slice(splitIndex), splitIndex };
}

/**
 * Grid/random-search a strategy's inputs over an in-sample window, then validate
 * the top combos out-of-sample. Pure & deterministic.
 */
export function optimize(
  ir: StrategyIR,
  candles: Candle[],
  config: BacktestConfig,
  spec: OptimizeSpec,
  onProgress?: (done: number, total: number) => void
): OptimizeResult {
  const objective = spec.objective;
  const trainFrac = spec.trainFrac ?? DEFAULT_TRAIN_FRAC;
  const maxCombos = Math.max(1, spec.maxCombos ?? DEFAULT_MAX_COMBOS);

  // Only sweep params that name a real input; ignore unknowns defensively.
  const inputNames = new Set(ir.inputs.map((input) => input.name));
  const axes = spec.params
    .filter((p) => inputNames.has(p.name))
    .map((p) => ({ name: p.name, values: expandParam(p) }))
    .filter((axis) => axis.values.length > 0);

  const { train, test, splitIndex } = splitCandles(candles, trainFrac);

  let combos = axes.length ? cartesian(axes) : [{}];
  const totalCombos = combos.length;
  let truncated = false;
  if (combos.length > maxCombos) {
    truncated = true;
    combos = (spec.searchMode === "random")
      ? sampleCombos(combos, maxCombos, spec.seed ?? deriveSeed(axes, totalCombos))
      : combos.slice(0, maxCombos);
  }

  const evaluated = combos.length;
  const ranked: ComboResult[] = [];
  for (let i = 0; i < combos.length; i += 1) {
    const combo = combos[i];
    const cloned = cloneWithInputs(ir, combo);
    const run = runBacktest(cloned, train, config);
    ranked.push({ params: combo, score: scoreMetrics(run.metrics, objective), inSample: run.metrics });
    onProgress?.(i + 1, combos.length);
  }

  // Rank best-first; ties fall back to net profit for a stable-ish order.
  ranked.sort((a, b) => (b.score - a.score) || (b.inSample.netProfit - a.inSample.netProfit));

  // Re-test the top combos out-of-sample so the table can show OOS side-by-side.
  const topN = Math.min(ranked.length, 10);
  let bestOutSampleRun: BacktestResult | undefined;
  for (let i = 0; i < topN; i += 1) {
    if (test.length < 2) break;
    const cloned = cloneWithInputs(ir, ranked[i].params);
    const run = runBacktest(cloned, test, config);
    ranked[i].outSample = run.metrics;
    ranked[i].outScore = scoreMetrics(run.metrics, objective);
    if (i === 0) bestOutSampleRun = run;
  }

  return {
    ranked,
    best: ranked[0],
    totalCombos,
    evaluated,
    truncated,
    objective,
    trainFrac,
    splitIndex,
    bestOutSampleRun
  };
}

/** Deterministically sample `k` combos from `combos` without replacement. */
function sampleCombos(combos: ParamCombo[], k: number, seed: number): ParamCombo[] {
  const rand = mulberry32(seed);
  const pool = combos.map((_, i) => i);
  // Partial Fisher–Yates: pick the first k after shuffling those slots.
  for (let i = 0; i < k && i < pool.length; i += 1) {
    const j = i + Math.floor(rand() * (pool.length - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, k).map((i) => combos[i]);
}

function deriveSeed(axes: { name: string; values: number[] }[], total: number): number {
  let h = 0x9e3779b9 ^ (total * 2654435761);
  for (const axis of axes) {
    for (let i = 0; i < axis.name.length; i += 1) h = (h ^ axis.name.charCodeAt(i)) * 16777619;
  }
  return h >>> 0;
}

// ---------- walk-forward ----------

export interface FoldResult {
  fold: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  /** Winning combo from optimising this fold's train window. */
  params: ParamCombo;
  inSample: BacktestMetrics;
  /** Out-of-sample performance of that combo on this fold's test window. */
  outSample: BacktestMetrics;
  outScore: number;
}

export interface WalkForwardResult {
  folds: FoldResult[];
  objective: Objective;
  /** Aggregate metrics of the stitched OOS equity across all folds. */
  aggregate?: BacktestMetrics;
  /** Stitched out-of-sample equity curve across every fold. */
  stitchedEquity: { time: number; equity: number }[];
}

export interface WalkForwardOptions {
  /** Number of rolling folds (default 4). */
  folds?: number;
  /** Fraction of each fold window used to train (rest is the OOS test). */
  foldTrainFrac?: number;
}

/**
 * Rolling walk-forward: split the candle history into `folds` contiguous
 * windows. For each window, optimise on its train portion and record the
 * winning combo's out-of-sample performance on the remaining test portion.
 * The OOS equity of every fold is stitched into one continuous curve whose
 * aggregate metrics summarise the strategy's true forward performance.
 */
export function walkForward(
  ir: StrategyIR,
  candles: Candle[],
  config: BacktestConfig,
  spec: OptimizeSpec,
  options: WalkForwardOptions = {},
  onProgress?: (done: number, total: number) => void
): WalkForwardResult {
  const foldCount = Math.max(2, Math.floor(options.folds ?? 4));
  const foldTrainFrac = Math.min(0.9, Math.max(0.1, options.foldTrainFrac ?? spec.trainFrac ?? DEFAULT_TRAIN_FRAC));
  const objective = spec.objective;

  const folds: FoldResult[] = [];
  const stitchedEquity: { time: number; equity: number }[] = [];
  const stitchedTrades: BacktestResult["trades"] = [];

  const windowSize = Math.floor(candles.length / foldCount);
  // Not enough data to form meaningful folds.
  if (windowSize < 4) {
    return { folds, objective, stitchedEquity };
  }

  // Equity is compounded across folds: each fold's OOS run starts from the
  // running equity so the stitched curve is a single continuous account.
  let runningEquity = config.initialCapital ?? DEFAULT_CONFIG.initialCapital;

  for (let f = 0; f < foldCount; f += 1) {
    const from = f * windowSize;
    const to = f === foldCount - 1 ? candles.length : (f + 1) * windowSize;
    const window = candles.slice(from, to);
    if (window.length < 4) continue;

    const foldSpec: OptimizeSpec = { ...spec, trainFrac: foldTrainFrac };
    const opt = optimize(ir, window, { ...config, initialCapital: runningEquity }, foldSpec);
    const best = opt.best;
    if (!best) continue;

    const { train, test } = splitCandles(window, foldTrainFrac);
    if (test.length < 2) continue;

    const cloned = cloneWithInputs(ir, best.params);
    const oosRun = runBacktest(cloned, test, { ...config, initialCapital: runningEquity });

    for (const point of oosRun.equityCurve) stitchedEquity.push(point);
    for (const trade of oosRun.trades) stitchedTrades.push(trade);
    runningEquity = oosRun.metrics.finalEquity;

    folds.push({
      fold: f,
      trainFrom: train[0]?.time ?? 0,
      trainTo: train.at(-1)?.time ?? 0,
      testFrom: test[0]?.time ?? 0,
      testTo: test.at(-1)?.time ?? 0,
      params: best.params,
      inSample: best.inSample,
      outSample: oosRun.metrics,
      outScore: scoreMetrics(oosRun.metrics, objective)
    });
    onProgress?.(f + 1, foldCount);
  }

  const aggregate = folds.length ? aggregateOos(folds, stitchedEquity, config.initialCapital ?? DEFAULT_CONFIG.initialCapital) : undefined;
  return { folds, objective, aggregate, stitchedEquity };
}

/** Summarise the stitched OOS folds into a single metrics block. */
function aggregateOos(
  folds: FoldResult[],
  stitchedEquity: { time: number; equity: number }[],
  initialCapital: number
): BacktestMetrics {
  const startEquity = stitchedEquity[0]?.equity ?? initialCapital;
  const finalEquity = stitchedEquity.at(-1)?.equity ?? initialCapital;
  const netProfit = finalEquity - startEquity;

  let peak = startEquity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const point of stitchedEquity) {
    peak = Math.max(peak, point.equity);
    const dd = peak - point.equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Sum trade-count-weighted stats from each fold's OOS metrics.
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let fundingPaid = 0;
  let liquidated = false;
  for (const fold of folds) {
    wins += fold.outSample.wins;
    losses += fold.outSample.losses;
    totalTrades += fold.outSample.totalTrades;
    fundingPaid += fold.outSample.fundingPaid;
    liquidated = liquidated || fold.outSample.liquidated;
  }

  const returns: number[] = [];
  for (let i = 1; i < stitchedEquity.length; i += 1) {
    const prev = stitchedEquity[i - 1].equity;
    if (prev > 0) returns.push((stitchedEquity[i].equity - prev) / prev);
  }
  const meanRet = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - meanRet) ** 2, 0) / returns.length : 0;
  const stdRet = Math.sqrt(variance);
  // Coarse annualisation: assume the stitched bars share the folds' cadence.
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(returns.length || 1) : 0;

  // Fold-level profit factor: winning folds' profit over losing folds' loss.
  const grossProfit = folds.reduce((s, f) => s + Math.max(0, f.outSample.netProfit), 0);
  const grossLossAbs = folds.reduce((s, f) => s + Math.max(0, -f.outSample.netProfit), 0);

  return {
    netProfit,
    netProfitPct: startEquity > 0 ? (netProfit / startEquity) * 100 : 0,
    totalTrades,
    wins,
    losses,
    winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    maxDrawdownPct,
    sharpe,
    avgTrade: totalTrades ? netProfit / totalTrades : 0,
    expectancy: totalTrades ? netProfit / totalTrades : 0,
    timeInMarketPct: 0,
    finalEquity,
    avgMaePct: 0,
    avgMfePct: 0,
    fundingPaid,
    liquidated
  };
}
