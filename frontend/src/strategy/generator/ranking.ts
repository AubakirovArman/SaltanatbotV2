import { boundedInt, clamp, finiteOr } from "./random";
import type { CandidateEvaluationSet, EvaluationMetrics, MarketEvaluation, MarketScore, MultiMarketRankingPolicy, RankedCandidateEvaluation, RankingValidation, RankingValidationFlags } from "./types";

const FAIL_SCORE = -1e12;

export const DEFAULT_MULTI_MARKET_RANKING_POLICY: Readonly<MultiMarketRankingPolicy> = {
  minMarkets: 2,
  minTradesPerWindow: 5,
  trainWeight: 0.4,
  outOfSampleWeight: 0.6,
  netProfitWeight: 1,
  sharpeWeight: 6,
  profitFactorWeight: 4,
  drawdownPenalty: 0.7,
  tradeShortfallPenalty: 2,
  liquidationPenalty: 250,
  generalizationGapPenalty: 0.4,
  outOfSampleLossPenalty: 0.8,
  crossMarketDispersionPenalty: 0.25,
  losingMarketPenalty: 8,
  medianWeight: 0.7,
  worstMarketWeight: 0.3
};

/** Rank caller-supplied train/OOS metrics without loading data or running tests. */
export function rankMultiMarketEvaluations(evaluations: readonly CandidateEvaluationSet[], overrides: Partial<MultiMarketRankingPolicy> = {}): RankedCandidateEvaluation[] {
  const policy = resolveRankingPolicy(overrides);
  return evaluations.map((evaluation) => rankCandidate(evaluation, policy)).sort(compareRanked);
}

export function resolveRankingPolicy(overrides: Partial<MultiMarketRankingPolicy> = {}): MultiMarketRankingPolicy {
  const policy = { ...DEFAULT_MULTI_MARKET_RANKING_POLICY };
  for (const [key, value] of Object.entries(overrides) as [keyof MultiMarketRankingPolicy, number][]) {
    if (Number.isFinite(value)) policy[key] = value;
  }
  policy.minMarkets = boundedInt(policy.minMarkets, 2, 1, 1_000);
  policy.minTradesPerWindow = boundedInt(policy.minTradesPerWindow, 5, 0, 1_000_000);
  for (const key of Object.keys(policy) as (keyof MultiMarketRankingPolicy)[]) {
    if (key !== "minMarkets" && key !== "minTradesPerWindow") policy[key] = clamp(finiteOr(policy[key], DEFAULT_MULTI_MARKET_RANKING_POLICY[key]), 0, 1_000);
  }
  if (policy.trainWeight + policy.outOfSampleWeight === 0) policy.outOfSampleWeight = 1;
  if (policy.medianWeight + policy.worstMarketWeight === 0) policy.medianWeight = 1;
  return policy;
}

function rankCandidate(evaluation: CandidateEvaluationSet, policy: MultiMarketRankingPolicy): RankedCandidateEvaluation {
  const uniqueMarkets = uniqueByMarketId(evaluation.markets);
  const validation = validateEvaluationSet(evaluation, uniqueMarkets, policy);
  const marketScores = uniqueMarkets.map((market) => scoreMarket(market, policy)).sort((left, right) => compareText(left.marketId, right.marketId));
  const totals = marketScores.map((market) => market.total);
  const medianScore = median(totals);
  const worstMarket = totals.length ? Math.min(...totals) : FAIL_SCORE;
  const marketDispersion = dispersion(totals);
  const dispersionPenalty = finiteScore(marketDispersion * policy.crossMarketDispersionPenalty);
  const losingMarkets = uniqueMarkets.filter((market) => market.outOfSample.netProfitPct < 0).length;
  const losingMarketPenalty = finiteScore(losingMarkets * policy.losingMarketPenalty);
  const robustWeight = Math.max(1e-9, policy.medianWeight + policy.worstMarketWeight);
  const robustScore = (medianScore * policy.medianWeight + worstMarket * policy.worstMarketWeight) / robustWeight;
  const score = validation.flags.finiteMetrics && marketScores.length ? finiteScore(robustScore - dispersionPenalty - losingMarketPenalty) : FAIL_SCORE;
  return {
    candidateFingerprint: evaluation.candidateFingerprint,
    score,
    marketScores,
    aggregate: { median: medianScore, worstMarket, dispersion: marketDispersion, dispersionPenalty, losingMarketPenalty },
    validation
  };
}

function scoreMarket(market: MarketEvaluation, policy: MultiMarketRankingPolicy): MarketScore {
  const trainScore = scoreWindow(market.train, policy);
  const outOfSampleScore = scoreWindow(market.outOfSample, policy);
  const weight = Math.max(1e-9, policy.trainWeight + policy.outOfSampleWeight);
  const generalizationPenalty = finiteScore(Math.abs(market.train.netProfitPct - market.outOfSample.netProfitPct) * policy.generalizationGapPenalty);
  const outOfSampleLossPenalty = finiteScore(Math.max(0, -market.outOfSample.netProfitPct) * policy.outOfSampleLossPenalty);
  const total = finiteScore((trainScore * policy.trainWeight + outOfSampleScore * policy.outOfSampleWeight) / weight - generalizationPenalty - outOfSampleLossPenalty);
  return { marketId: market.marketId, trainScore, outOfSampleScore, generalizationPenalty, outOfSampleLossPenalty, total };
}

function scoreWindow(metrics: EvaluationMetrics, policy: MultiMarketRankingPolicy): number {
  if (!metricsFinite(metrics)) return FAIL_SCORE;
  const reward = metrics.netProfitPct * policy.netProfitWeight + clamp(metrics.sharpe, -5, 5) * policy.sharpeWeight + clamp(metrics.profitFactor - 1, -1, 4) * policy.profitFactorWeight;
  const penalty = Math.max(0, metrics.maxDrawdownPct) * policy.drawdownPenalty + Math.max(0, policy.minTradesPerWindow - metrics.trades) * policy.tradeShortfallPenalty + (metrics.liquidated ? policy.liquidationPenalty : 0);
  return finiteScore(reward - penalty);
}

function validateEvaluationSet(evaluation: CandidateEvaluationSet, uniqueMarkets: readonly MarketEvaluation[], policy: MultiMarketRankingPolicy): RankingValidation {
  const flags: RankingValidationFlags = {
    hasRequiredMarkets: uniqueMarkets.length >= policy.minMarkets,
    uniqueMarkets: uniqueMarkets.length === evaluation.markets.length && uniqueMarkets.every((market) => market.marketId.trim().length > 0),
    finiteMetrics: uniqueMarkets.every((market) => metricsFinite(market.train) && metricsFinite(market.outOfSample)),
    enoughTrades: uniqueMarkets.every((market) => market.train.trades >= policy.minTradesPerWindow && market.outOfSample.trades >= policy.minTradesPerWindow),
    noLiquidations: uniqueMarkets.every((market) => !market.train.liquidated && !market.outOfSample.liquidated),
    majorityOutOfSampleProfitable: uniqueMarkets.length > 0 && uniqueMarkets.filter((market) => market.outOfSample.netProfitPct > 0).length > uniqueMarkets.length / 2
  };
  const issues = Object.entries(flags)
    .filter(([, passed]) => !passed)
    .map(([flag]) => flag);
  if (!evaluation.candidateFingerprint.trim()) issues.push("candidateFingerprint");
  return { valid: issues.length === 0, flags, issues };
}

function uniqueByMarketId(markets: readonly MarketEvaluation[]): MarketEvaluation[] {
  const unique = new Map<string, MarketEvaluation>();
  for (const market of markets) {
    const normalizedMarketId = market.marketId.trim();
    if (!unique.has(normalizedMarketId)) unique.set(normalizedMarketId, market);
  }
  return [...unique.values()];
}

function metricsFinite(metrics: EvaluationMetrics): boolean {
  return [metrics.netProfitPct, metrics.sharpe, metrics.profitFactor, metrics.maxDrawdownPct, metrics.trades].every(Number.isFinite) && metrics.profitFactor >= 0 && metrics.maxDrawdownPct >= 0 && Number.isInteger(metrics.trades) && metrics.trades >= 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return FAIL_SCORE;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dispersion(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function compareRanked(left: RankedCandidateEvaluation, right: RankedCandidateEvaluation): number {
  if (left.validation.valid !== right.validation.valid) return left.validation.valid ? -1 : 1;
  return right.score - left.score || compareText(left.candidateFingerprint, right.candidateFingerprint);
}

function finiteScore(value: number): number {
  if (!Number.isFinite(value)) return FAIL_SCORE;
  if (value < FAIL_SCORE || value > -FAIL_SCORE) return FAIL_SCORE;
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
