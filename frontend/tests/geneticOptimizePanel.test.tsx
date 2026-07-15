// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OptimizePanel } from "../src/strategy/components/OptimizePanel";
import type { GeneticOptimizeResult } from "../src/strategy/geneticOptimizer";
import type { BacktestMetrics } from "../src/strategy/backtest";

const metrics: BacktestMetrics = {
  netProfit: 120,
  netProfitPct: 1.2,
  totalTrades: 12,
  wins: 8,
  losses: 4,
  winRate: 66.67,
  profitFactor: 1.8,
  maxDrawdown: 30,
  maxDrawdownPct: 2.4,
  sharpe: 1.3,
  avgTrade: 10,
  expectancy: 10,
  timeInMarketPct: 40,
  finalEquity: 10_120,
  avgMaePct: 0,
  avgMfePct: 0,
  fundingPaid: 0,
  liquidated: false
};

const candidate = {
  params: { fast: 10 },
  canonicalKey: '[["fast",10]]',
  generationCreated: 1,
  fitness: {
    train: { reward: 10, penalty: 1, score: 9 },
    validation: { reward: 8, penalty: 1, score: 7 },
    generalizationGapPenalty: 0.5,
    validationLossPenalty: 0,
    total: 7.8
  },
  trainSample: metrics,
  validationSample: metrics,
  testSample: metrics,
  holdout: { passed: true, reasons: [] }
};

const geneticResult: GeneticOptimizeResult = {
  ranked: [candidate],
  best: candidate,
  bestHoldoutPassed: candidate,
  axes: [{ name: "fast", values: [5, 10, 15] }],
  config: {
    seed: 42,
    populationSize: 16,
    generations: 5,
    trainFrac: 0.7,
    eliteCount: 2,
    tournamentSize: 3,
    crossoverRate: 0.85,
    mutationRate: 0.15,
    mutationSpan: 0.2,
    resultLimit: 100,
    fitness: {
      netProfitPctWeight: 1,
      sharpeWeight: 8,
      profitFactorWeight: 4,
      returnOverDrawdownWeight: 8,
      winRateWeight: 0.5,
      drawdownPenalty: 1,
      tradeShortfallPenalty: 3,
      liquidationPenalty: 250,
      generalizationGapPenalty: 0.35,
      validationLossPenalty: 0.5,
      minTradesPerWindow: 3,
      trainWeight: 0.6,
      validationWeight: 0.4
    },
    validation: { minTrades: 3, minNetProfitPct: 0, maxDrawdownPct: 30 }
  },
  trainEndIndex: 70,
  validationEndIndex: 85,
  trainBars: 70,
  validationBars: 15,
  testBars: 15,
  requiredWarmupBars: 1,
  holdoutEvaluated: 1,
  searchSpaceSize: 3,
  uniqueEvaluated: 3,
  cacheHits: 77,
  processed: 81
};

describe("genetic optimizer panel", () => {
  it("renders bounded genetic controls and separate validation/test evidence in Russian", () => {
    const html = renderToStaticMarkup(
      <OptimizePanel
        locale="ru"
        spec={{ objective: "netProfit", trainFrac: 0.7, axes: [{ name: "fast", min: 5, max: 15, step: 5, enabled: true }] }}
        inputs={[{ name: "fast", value: 10, min: 5, max: 15, step: 5 }]}
        onSpecChange={() => {}}
        onRun={() => {}}
        onCancel={() => {}}
        optimizing={false}
        progress={{ done: 0, total: 0 }}
        mode="genetic"
        onModeChange={() => {}}
        geneticConfig={{ populationSize: 16, generations: 5, mutationRate: 0.15, seed: 42 }}
        onGeneticConfigChange={() => {}}
        geneticResult={geneticResult}
        walkForwardOn={false}
        onToggleWalkForward={() => {}}
        folds={4}
        onFoldsChange={() => {}}
        walkForwardMode="rolling"
        onWalkForwardModeChange={() => {}}
        onApplyCombo={() => {}}
        decimals={2}
      />
    );

    expect(html).toContain("Генетический");
    expect(html).toContain("Популяция");
    expect(html).toContain("Мутация %");
    expect(html).toContain("Генетический рейтинг");
    expect(html).toContain("<table>");
    expect(html).toContain("Validation P&amp;L");
    expect(html).toContain("Test P&amp;L");
    expect(html).toContain("Test пройден");
    expect(html).toContain("Применить");
    expect(html).not.toContain("OOS пройден");
    expect(html).not.toContain("Walk-forward</label>");
  });
});
