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
  assumptions: []
} satisfies PortfolioBacktestResult;

describe("PortfolioBacktestReport", () => {
  it.each([
    ["en", "Portfolio backtest", "Contribution by market"],
    ["ru", "Портфельный бэктест", "Вклад по рынкам"],
    ["kk", "Портфель бэктесті", "Нарықтар бойынша үлес"]
  ] as const)("renders semantic tables and the v1 caveat in %s", (locale, title, caption) => {
    const html = renderToStaticMarkup(<PortfolioBacktestReport locale={locale} result={result} />);
    expect(html).toContain(`<h3 id="portfolio-report-title">${title}</h3>`);
    expect(html).toContain(`<caption>${caption}</caption>`);
    expect(html).toContain("role=\"note\"");
    expect(html).toContain("<svg");
    expect(html).toContain("BTCUSDT");
  });
});
