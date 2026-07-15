import { describe, expect, it } from "vitest";
import { rankMultiMarketEvaluations, type CandidateEvaluationSet, type EvaluationMetrics, type MarketEvaluation } from "../src/strategy/generator";

function metrics(overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics {
  return {
    netProfitPct: 6,
    sharpe: 1.4,
    profitFactor: 1.6,
    maxDrawdownPct: 4,
    trades: 20,
    liquidated: false,
    ...overrides
  };
}

function market(marketId: string, train: Partial<EvaluationMetrics> = {}, outOfSample: Partial<EvaluationMetrics> = {}): MarketEvaluation {
  return { marketId, train: metrics(train), outOfSample: metrics(outOfSample) };
}

describe("multi-market strategy candidate ranking", () => {
  it("ranks robust OOS performance above an overfit training result", () => {
    const robust: CandidateEvaluationSet = {
      candidateFingerprint: "robust",
      markets: [market("BTC/USDT", { netProfitPct: 8 }, { netProfitPct: 6 }), market("ETH/USDT", { netProfitPct: 7 }, { netProfitPct: 5 })]
    };
    const overfit: CandidateEvaluationSet = {
      candidateFingerprint: "overfit",
      markets: [market("BTC/USDT", { netProfitPct: 45, sharpe: 4 }, { netProfitPct: -12, sharpe: -1 }), market("ETH/USDT", { netProfitPct: 40, sharpe: 4 }, { netProfitPct: -9, sharpe: -1 })]
    };

    const ranked = rankMultiMarketEvaluations([overfit, robust]);
    expect(ranked.map((candidate) => candidate.candidateFingerprint)).toEqual(["robust", "overfit"]);
    expect(ranked[1].marketScores[0].generalizationPenalty).toBeGreaterThan(ranked[0].marketScores[0].generalizationPenalty);
    expect(ranked[1].aggregate.losingMarketPenalty).toBeGreaterThan(0);
  });

  it("penalizes cross-market dispersion and the worst market", () => {
    const stable: CandidateEvaluationSet = {
      candidateFingerprint: "stable",
      markets: [market("BTC", {}, { netProfitPct: 5 }), market("ETH", {}, { netProfitPct: 4 }), market("SOL", {}, { netProfitPct: 6 })]
    };
    const concentrated: CandidateEvaluationSet = {
      candidateFingerprint: "concentrated",
      markets: [market("BTC", { netProfitPct: 20 }, { netProfitPct: 20 }), market("ETH", { netProfitPct: 20 }, { netProfitPct: 20 }), market("SOL", { netProfitPct: -2 }, { netProfitPct: -2 })]
    };

    const ranked = rankMultiMarketEvaluations([concentrated, stable], { crossMarketDispersionPenalty: 1, worstMarketWeight: 0.6, medianWeight: 0.4 });
    expect(ranked[0].candidateFingerprint).toBe("stable");
    expect(ranked[1].aggregate.dispersion).toBeGreaterThan(ranked[0].aggregate.dispersion);
    expect(ranked[1].aggregate.worstMarket).toBeLessThan(ranked[0].aggregate.worstMarket);
  });

  it("fails validation for insufficient, duplicate, non-finite or liquidated evaluation data", () => {
    const invalid: CandidateEvaluationSet[] = [
      { candidateFingerprint: "one-market", markets: [market("BTC")] },
      { candidateFingerprint: "duplicate", markets: [market("BTC"), market("BTC")] },
      { candidateFingerprint: "trimmed-duplicate", markets: [market("BTC"), market(" BTC ")] },
      { candidateFingerprint: "non-finite", markets: [market("BTC", { sharpe: Number.NaN }), market("ETH")] },
      { candidateFingerprint: "liquidated", markets: [market("BTC", {}, { liquidated: true }), market("ETH")] },
      { candidateFingerprint: "few-trades", markets: [market("BTC", {}, { trades: 1 }), market("ETH")] }
    ];
    const ranked = rankMultiMarketEvaluations(invalid);
    const byId = new Map(ranked.map((candidate) => [candidate.candidateFingerprint, candidate]));

    expect(byId.get("one-market")?.validation.flags.hasRequiredMarkets).toBe(false);
    expect(byId.get("duplicate")?.validation.flags.uniqueMarkets).toBe(false);
    expect(byId.get("trimmed-duplicate")?.validation.flags.uniqueMarkets).toBe(false);
    expect(byId.get("non-finite")?.validation.flags.finiteMetrics).toBe(false);
    expect(byId.get("non-finite")?.score).toBe(-1e12);
    expect(byId.get("liquidated")?.validation.flags.noLiquidations).toBe(false);
    expect(byId.get("few-trades")?.validation.flags.enoughTrades).toBe(false);
    expect(ranked.every((candidate) => !candidate.validation.valid)).toBe(true);
  });

  it("fails closed when finite inputs overflow an intermediate score", () => {
    const overflow: CandidateEvaluationSet = {
      candidateFingerprint: "overflow",
      markets: [
        market("BTC", { netProfitPct: Number.MAX_VALUE }, { netProfitPct: Number.MAX_VALUE }),
        market("ETH", { netProfitPct: Number.MAX_VALUE }, { netProfitPct: Number.MAX_VALUE })
      ]
    };
    const normal: CandidateEvaluationSet = {
      candidateFingerprint: "normal",
      markets: [market("BTC"), market("ETH")]
    };

    const ranked = rankMultiMarketEvaluations([overflow, normal]);
    const overflowResult = ranked.find((candidate) => candidate.candidateFingerprint === "overflow");
    expect(ranked[0].candidateFingerprint).toBe("normal");
    expect(overflowResult?.score).toBe(-1e12);
    expect(overflowResult?.marketScores.every((marketScore) => marketScore.total === -1e12)).toBe(true);
  });

  it("is invariant to candidate and market input order", () => {
    const alpha: CandidateEvaluationSet = { candidateFingerprint: "alpha", markets: [market("SOL", {}, { netProfitPct: 3 }), market("BTC", {}, { netProfitPct: 5 })] };
    const beta: CandidateEvaluationSet = { candidateFingerprint: "beta", markets: [market("ETH", {}, { netProfitPct: 6 }), market("BTC", {}, { netProfitPct: 4 })] };
    const first = rankMultiMarketEvaluations([alpha, beta]);
    const second = rankMultiMarketEvaluations([
      { ...beta, markets: [...beta.markets].reverse() },
      { ...alpha, markets: [...alpha.markets].reverse() }
    ]);
    expect(second).toEqual(first);
  });

  it("uses deterministic fingerprint tie-breaking", () => {
    const sameMarkets = [market("BTC"), market("ETH")];
    const ranked = rankMultiMarketEvaluations([
      { candidateFingerprint: "zeta", markets: sameMarkets },
      { candidateFingerprint: "alpha", markets: sameMarkets }
    ]);
    expect(ranked.map((candidate) => candidate.candidateFingerprint)).toEqual(["alpha", "zeta"]);
  });
});
