import { canonicalStrategyJson } from "@saltanatbotv2/strategy-generator";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";

/**
 * GA objective vectors, out-of-sample overfitting report and Pareto
 * non-dominated sorting (ADR 0003 / R9.2). Everything here is pure and
 * deterministic: identical evaluation metrics produce identical objective
 * vectors, ranks and flags, which the seeded-reproducibility release
 * criterion depends on. Ranking always reads OUT-OF-SAMPLE metrics — train
 * windows only ever enter the overfitting gap report.
 */

export const GA_OBJECTIVE_KEYS = ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"] as const;

export type GaObjectiveKey = (typeof GA_OBJECTIVE_KEYS)[number];

/** Optimization direction per objective; minimized objectives are negated for dominance checks. */
export const GA_OBJECTIVE_DIRECTIONS: Readonly<Record<GaObjectiveKey, "max" | "min">> = {
  netProfitPct: "max",
  maxDrawdownPct: "min",
  sharpe: "max",
  complexity: "min"
};

/** Train-vs-OOS gap (direction-adjusted, positive = worse out-of-sample) beyond which a candidate is flagged overfit. */
export const GA_OVERFIT_GAP_THRESHOLDS: Readonly<Record<GaObjectiveKey, number>> = {
  netProfitPct: 25,
  maxDrawdownPct: 20,
  sharpe: 1.5,
  complexity: Number.POSITIVE_INFINITY
};

/** Cross-market OOS net-profit dispersion beyond which a candidate is flagged unstable. */
export const GA_UNSTABLE_DISPERSION_THRESHOLD = 30;
/** Share of losing OOS markets beyond which a candidate is flagged unstable. */
export const GA_UNSTABLE_OOS_LOSS_SHARE = 0.5;

export class GaObjectiveError extends Error {}

/** One market's train/OOS metric pair as read from the backtest reports. */
export interface GaMarketWindowMetrics {
  symbol: string;
  train: { netProfitPct: number; maxDrawdownPct: number; sharpe: number };
  outOfSample: { netProfitPct: number; maxDrawdownPct: number; sharpe: number };
}

export interface GaOosReport {
  gapPct: Partial<Record<GaObjectiveKey, number>>;
  oosLossShare: number;
  dispersion: number;
  flags: { overfit: boolean; unstable: boolean };
}

/**
 * Deterministic structural complexity: the byte length of the canonical
 * strategy JSON. Monotone in grammar size, independent of key ordering, and
 * available without interpreting the IR.
 */
export function strategyComplexity(ir: StrategyIR): number {
  return canonicalStrategyJson(ir).length;
}

/**
 * Scalar objective vector over OUT-OF-SAMPLE portfolio metrics (the shared
 * cross-market OOS section, which equals the single market's OOS metrics for
 * one-market runs) plus structural complexity. Fails closed on non-finite
 * metrics: a corrupt objective would silently poison every dominance check.
 */
export function computeObjectiveVector(
  objectives: readonly GaObjectiveKey[],
  portfolioOutOfSample: { netProfitPct: number; maxDrawdownPct: number; sharpe: number },
  complexity: number
): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const key of objectives) {
    const value = key === "complexity" ? complexity : portfolioOutOfSample[key];
    if (!Number.isFinite(value)) throw new GaObjectiveError(`Objective ${key} is not finite.`);
    vector[key] = value;
  }
  return vector;
}

/**
 * Overfitting signals per candidate: direction-adjusted train-vs-OOS gap for
 * every metric objective (positive = the OOS window is worse than train), the
 * share of losing OOS markets and the cross-market OOS net-profit dispersion.
 * Promotion later requires this report present with `overfit` false.
 */
export function buildOosReport(objectives: readonly GaObjectiveKey[], markets: readonly GaMarketWindowMetrics[]): GaOosReport {
  if (markets.length === 0) throw new GaObjectiveError("An OOS report requires at least one evaluated market.");
  const gapPct: Partial<Record<GaObjectiveKey, number>> = {};
  let overfit = false;
  for (const key of objectives) {
    if (key === "complexity") continue;
    const train = meanOf(markets.map((market) => metricValue(market.train, key)));
    const outOfSample = meanOf(markets.map((market) => metricValue(market.outOfSample, key)));
    // Positive gap always means "worse out of sample", regardless of direction.
    const gap = GA_OBJECTIVE_DIRECTIONS[key] === "max" ? train - outOfSample : outOfSample - train;
    if (!Number.isFinite(gap)) throw new GaObjectiveError(`OOS gap for ${key} is not finite.`);
    gapPct[key] = roundStable(gap);
    if (gap > GA_OVERFIT_GAP_THRESHOLDS[key]) overfit = true;
  }
  const oosProfits = markets.map((market) => market.outOfSample.netProfitPct);
  const oosLossShare = roundStable(oosProfits.filter((value) => value < 0).length / markets.length);
  const dispersion = roundStable(standardDeviation(oosProfits));
  const unstable = dispersion > GA_UNSTABLE_DISPERSION_THRESHOLD || oosLossShare > GA_UNSTABLE_OOS_LOSS_SHARE;
  return { gapPct, oosLossShare, dispersion, flags: { overfit, unstable } };
}

export interface GaParetoPoint {
  fingerprint: string;
  objectives: Record<string, number>;
}

/**
 * Non-dominated sorting over the configured objective vector: rank 0 is the
 * Pareto frontier, rank 1 the frontier after removing rank 0, and so on.
 * O(n^2) per layer is fine for the bounded run size (<= 64 * 16 candidates)
 * and keeps the algorithm obviously deterministic.
 */
export function computeParetoRanks(points: readonly GaParetoPoint[], objectives: readonly GaObjectiveKey[]): Map<string, number> {
  const normalized = points.map((point) => ({
    fingerprint: point.fingerprint,
    values: objectives.map((key) => {
      const value = point.objectives[key];
      if (!Number.isFinite(value)) throw new GaObjectiveError(`Candidate ${point.fingerprint} is missing finite objective ${key}.`);
      return GA_OBJECTIVE_DIRECTIONS[key] === "max" ? (value as number) : -(value as number);
    })
  }));
  const ranks = new Map<string, number>();
  let remaining = normalized;
  let rank = 0;
  while (remaining.length > 0) {
    const frontier = remaining.filter((candidate) => !remaining.some((other) => other !== candidate && dominates(other.values, candidate.values)));
    // A dominance cycle is impossible; an empty frontier would mean a NaN slipped through.
    if (frontier.length === 0) throw new GaObjectiveError("Pareto sorting could not extract a frontier layer.");
    for (const candidate of frontier) ranks.set(candidate.fingerprint, rank);
    const frontierSet = new Set(frontier);
    remaining = remaining.filter((candidate) => !frontierSet.has(candidate));
    rank += 1;
  }
  return ranks;
}

/** True when left is at least as good everywhere and strictly better somewhere (all values maximized). */
function dominates(left: readonly number[], right: readonly number[]): boolean {
  let strictlyBetter = false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return false;
    if (left[index]! > right[index]!) strictlyBetter = true;
  }
  return strictlyBetter;
}

function metricValue(window: { netProfitPct: number; maxDrawdownPct: number; sharpe: number }, key: Exclude<GaObjectiveKey, "complexity">): number {
  const value = window[key];
  if (!Number.isFinite(value)) throw new GaObjectiveError(`Evaluation metric ${key} is not finite.`);
  return value;
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = meanOf(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

/** 12 significant digits keeps stored JSON stable across platforms without losing signal. */
function roundStable(value: number): number {
  if (value === 0) return 0;
  return Number.parseFloat(value.toPrecision(12));
}
