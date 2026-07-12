import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PortfolioBacktestResult } from "@saltanatbotv2/backtest-core";
import { PortfolioBacktestReport } from "../src/components/PortfolioBacktestReport";

const result = {
  schemaVersion: 1,
  kind: "saltanat-portfolio-backtest",
  name: "EMA portfolio",
  config: { initialCapital: 10_000, maxConcurrentPositions: 2, maxGrossExposurePct: 100, maxPositionExposurePct: 50, minAllocationPct: 25 },
  symbols: ["BTCUSDT", "ETHUSDT"],
  commonRange: { fromTime: 0, toTime: 3_600_000, points: 2 },
  equityCurve: [{ time: 0, equity: 10_000, grossExposure: 0, grossExposurePct: 0, openPositions: 0 }, { time: 3_600_000, equity: 10_100, grossExposure: 0, grossExposurePct: 0, openPositions: 0 }],
  trades: [],
  rejectedEntries: [],
  contributions: [
    { symbol: "BTCUSDT", candidateTrades: 1, acceptedTrades: 1, rejectedTrades: 0, wins: 1, netProfit: 100, fundingPaid: 0, contributionPct: 100 },
    { symbol: "ETHUSDT", candidateTrades: 0, acceptedTrades: 0, rejectedTrades: 0, wins: 0, netProfit: 0, fundingPaid: 0, contributionPct: 0 }
  ],
  correlation: { symbols: ["BTCUSDT", "ETHUSDT"], values: [[1, 0.5], [0.5, 1]], averagePairwise: 0.5 },
  metrics: { netProfit: 100, netProfitPct: 1, finalEquity: 10_100, totalCandidates: 1, acceptedTrades: 1, rejectedTrades: 0, excludedCandidates: 0, wins: 1, winRate: 100, profitFactor: Infinity, maxDrawdown: 0, maxDrawdownPct: 0, sharpe: 1, timeInMarketPct: 50, peakGrossExposurePct: 50, maxConcurrentPositions: 1, fundingPaid: 0 },
  risk: {
    historical: { observations: 1, lossProbabilityPct: 0, valueAtRisk95Pct: 0, expectedShortfall95Pct: 0, valueAtRisk99Pct: 0, expectedShortfall99Pct: 0, worstPeriodPct: 0, ulcerIndex: 0, longestRecoveryPeriods: 0 },
    concentration: { largestSymbol: "BTCUSDT", largestAllocationPct: 100, effectiveSymbols: 1, herfindahlIndex: 1, allocations: [{ symbol: "BTCUSDT", allocatedNotional: 100, sharePct: 100 }] },
    monteCarlo: null,
    stress: { baselineNetProfit: 100, turnover: 200, breakEvenExtraFillCostBps: 5_000, scenarios: [{ id: "execution_cost", extraFillCostBps: 5, adverseExitBps: 0, fundingMultiplier: 1, extraCost: 1, netProfit: 99, netProfitPct: 0.99, finalEquity: 10_099, maxDrawdown: 1, maxDrawdownPct: 0.01, deltaFromBaseline: -1, profitable: true }] }
  },
  assumptions: []
} satisfies PortfolioBacktestResult;

describe("PortfolioBacktestReport", () => {
  it.each([
    ["en", "Portfolio backtest", "Contribution by market", "Portfolio risk lab", "Portfolio stress scenarios"],
    ["ru", "Портфельный бэктест", "Вклад по рынкам", "Лаборатория риска портфеля", "Стресс-сценарии портфеля"],
    ["kk", "Портфель бэктесті", "Нарықтар бойынша үлес", "Портфель тәуекел зертханасы", "Портфель стресс-сценарийлері"]
  ] as const)("renders semantic tables, risk and the v1 caveat in %s", (locale, title, caption, riskTitle, stressCaption) => {
    const html = renderToStaticMarkup(<PortfolioBacktestReport locale={locale} result={result} />);
    expect(html).toContain(`<h3 id="portfolio-report-title">${title}</h3>`);
    expect(html).toContain(`<caption>${caption}</caption>`);
    expect(html).toContain(riskTitle);
    expect(html).toContain(`<caption>${stressCaption}</caption>`);
    expect(html).toContain("role=\"note\"");
    expect(html).toContain("<svg");
    expect(html).toContain("BTCUSDT");
  });
});
