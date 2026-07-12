import type { Candle } from "@saltanatbotv2/contracts";
import type { BacktestExecutionEvent } from "./executionTrace.js";
import { analyzePortfolioExecution, type PortfolioExecutionAnalysis } from "./portfolioExecution.js";
import { analyzePortfolioRisk, type PortfolioRiskAnalysis } from "./portfolioRisk.js";
import type { BacktestResult, EquityPoint, Trade } from "./types.js";

export interface PortfolioBacktestConfig {
  initialCapital: number;
  maxConcurrentPositions: number;
  maxGrossExposurePct: number;
  maxPositionExposurePct: number;
  /** Reject a partial allocation smaller than this percentage of its target. */
  minAllocationPct: number;
}

export const DEFAULT_PORTFOLIO_BACKTEST_CONFIG: Readonly<PortfolioBacktestConfig> = Object.freeze({
  initialCapital: 10_000,
  maxConcurrentPositions: 3,
  maxGrossExposurePct: 100,
  maxPositionExposurePct: 35,
  minAllocationPct: 25
});

export interface PortfolioBacktestLeg {
  symbol: string;
  candles: Candle[];
  report: BacktestResult;
}

export interface PortfolioTrade extends Trade {
  symbol: string;
  requestedNotional: number;
  allocatedNotional: number;
  allocationPct: number;
  scale: number;
  fundingPaid: number;
}

export type PortfolioRejectionReason = "max_concurrent" | "gross_exposure" | "allocation_too_small" | "invalid_candidate";

export interface PortfolioRejectedEntry {
  symbol: string;
  time: number;
  reason: PortfolioRejectionReason;
  requestedNotional: number;
  availableNotional: number;
}

export interface PortfolioEquityPoint extends EquityPoint {
  grossExposure: number;
  grossExposurePct: number;
  openPositions: number;
}

export interface PortfolioSymbolContribution {
  symbol: string;
  candidateTrades: number;
  acceptedTrades: number;
  rejectedTrades: number;
  wins: number;
  netProfit: number;
  fundingPaid: number;
  contributionPct: number;
}

export interface PortfolioCorrelationMatrix {
  symbols: string[];
  values: Array<Array<number | null>>;
  averagePairwise: number | null;
}

export interface PortfolioBacktestMetrics {
  netProfit: number;
  netProfitPct: number;
  finalEquity: number;
  totalCandidates: number;
  acceptedTrades: number;
  rejectedTrades: number;
  excludedCandidates: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: number;
  timeInMarketPct: number;
  peakGrossExposurePct: number;
  maxConcurrentPositions: number;
  fundingPaid: number;
}

export interface PortfolioBacktestResult {
  readonly schemaVersion: 1;
  readonly kind: "saltanat-portfolio-backtest";
  name: string;
  config: Readonly<PortfolioBacktestConfig>;
  symbols: string[];
  commonRange: Readonly<{ fromTime: number; toTime: number; points: number }>;
  equityCurve: PortfolioEquityPoint[];
  trades: PortfolioTrade[];
  rejectedEntries: PortfolioRejectedEntry[];
  contributions: PortfolioSymbolContribution[];
  correlation: PortfolioCorrelationMatrix;
  metrics: PortfolioBacktestMetrics;
  execution: PortfolioExecutionAnalysis;
  risk: PortfolioRiskAnalysis;
  assumptions: string[];
}

interface Candidate {
  id: string;
  symbol: string;
  trade: Trade;
  originalCapital: number;
  originalNotional: number;
  requestedPct: number;
  funding: Array<{ time: number; amount: number }>;
}

interface ActiveCandidate {
  candidate: Candidate;
  requestedNotional: number;
  targetPct: number;
  allocatedNotional: number;
  scale: number;
  entryCommission: number;
  fundingPaid: number;
}

/**
 * Replay independently generated candidate fills through one chronological capital allocator.
 * Signal/fill prices remain those of each canonical single-market report; quantity is re-scaled
 * against shared mark-to-market equity and portfolio exposure limits.
 */
export function simulatePortfolioBacktest(
  legs: PortfolioBacktestLeg[],
  config: Partial<PortfolioBacktestConfig> = {}
): PortfolioBacktestResult {
  const cfg = sanitizePortfolioBacktestConfig(config);
  const safeLegs = normalizeLegs(legs);
  const symbols = safeLegs.map((leg) => leg.symbol);
  const fromTime = Math.max(0, ...safeLegs.map((leg) => leg.candles[0]?.time ?? 0));
  const toTime = Math.min(...safeLegs.map((leg) => leg.candles.at(-1)?.time ?? 0));
  const hasCommonRange = safeLegs.length >= 2 && Number.isFinite(toTime) && toTime >= fromTime;
  const times = hasCommonRange
    ? [...new Set(safeLegs.flatMap((leg) => leg.candles.filter((candle) => candle.time >= fromTime && candle.time <= toTime).map((candle) => candle.time)))].sort((a, b) => a - b)
    : [];
  const allCandidates = safeLegs.flatMap(buildCandidates);
  const candidates = allCandidates
    .filter((candidate) => candidate.trade.entryTime >= fromTime && candidate.trade.exitTime <= toTime)
    .sort((left, right) => left.trade.entryTime - right.trade.entryTime || left.symbol.localeCompare(right.symbol) || left.trade.exitTime - right.trade.exitTime);
  const excludedCandidates = allCandidates.length - candidates.length;
  const prices = createPriceReaders(safeLegs);
  const active: ActiveCandidate[] = [];
  const accepted: PortfolioTrade[] = [];
  const rejected: PortfolioRejectedEntry[] = [];
  const curve: PortfolioEquityPoint[] = [];
  let cash = cfg.initialCapital;
  let candidateIndex = 0;
  let peakConcurrent = 0;
  let fundingPaid = 0;

  for (const time of times) {
    for (const reader of prices.values()) reader.advance(time);

    for (const open of active) {
      for (const event of open.candidate.funding) {
        if (event.time !== time) continue;
        const amount = event.amount * open.scale;
        cash -= amount;
        open.fundingPaid += amount;
        fundingPaid += amount;
      }
    }

    for (let index = active.length - 1; index >= 0; index -= 1) {
      const open = active[index];
      if (open.candidate.trade.exitTime !== time) continue;
      const trade = scaleTrade(open);
      cash += trade.pnl;
      accepted.push(trade);
      active.splice(index, 1);
    }

    while (candidates[candidateIndex]?.trade.entryTime === time) {
      const candidate = candidates[candidateIndex++];
      const currentEquity = portfolioEquity(cash, active, prices);
      const targetPct = Math.min(candidate.requestedPct, cfg.maxPositionExposurePct);
      const requestedNotional = Math.max(0, currentEquity * targetPct / 100);
      const gross = grossExposure(active);
      const capacity = Math.max(0, currentEquity * cfg.maxGrossExposurePct / 100 - gross);
      let reason: PortfolioRejectionReason | undefined;
      if (!(candidate.originalNotional > 0) || !(requestedNotional > 0)) reason = "invalid_candidate";
      else if (active.length >= cfg.maxConcurrentPositions) reason = "max_concurrent";
      else if (!(capacity > 0)) reason = "gross_exposure";
      const allocatedNotional = Math.min(requestedNotional, capacity);
      if (!reason && allocatedNotional < requestedNotional * cfg.minAllocationPct / 100) reason = "allocation_too_small";
      if (reason) {
        rejected.push({ symbol: candidate.symbol, time, reason, requestedNotional, availableNotional: capacity });
        continue;
      }
      const scale = allocatedNotional / candidate.originalNotional;
      active.push({
        candidate,
        requestedNotional,
        targetPct,
        allocatedNotional,
        scale,
        entryCommission: allocatedNotional * (candidateReportCommission(safeLegs, candidate.symbol) / 100),
        fundingPaid: 0
      });
      peakConcurrent = Math.max(peakConcurrent, active.length);
    }

    const equity = portfolioEquity(cash, active, prices);
    const gross = grossExposure(active);
    curve.push({
      time,
      equity,
      grossExposure: gross,
      grossExposurePct: equity > 0 ? gross / equity * 100 : 0,
      openPositions: active.length
    });
  }

  accepted.sort((left, right) => left.entryTime - right.entryTime || left.symbol.localeCompare(right.symbol));
  const metrics = portfolioMetrics(cfg, curve, accepted, rejected.length, allCandidates.length, excludedCandidates, peakConcurrent, fundingPaid);
  return {
    schemaVersion: 1,
    kind: "saltanat-portfolio-backtest",
    name: `${safeLegs[0]?.report.name ?? "Strategy"} · Portfolio`,
    config: Object.freeze(cfg),
    symbols,
    commonRange: Object.freeze({ fromTime: hasCommonRange ? fromTime : 0, toTime: hasCommonRange ? toTime : 0, points: times.length }),
    equityCurve: curve,
    trades: accepted,
    rejectedEntries: rejected,
    contributions: symbolContributions(symbols, allCandidates, accepted, rejected, metrics.netProfit),
    correlation: correlationMatrix(safeLegs, fromTime, toTime),
    metrics,
    execution: analyzePortfolioExecution(accepted, safeLegs.map((leg) => ({
      symbol: leg.symbol,
      commissionPct: leg.report.metadata.config.commissionPct,
      slippagePct: leg.report.metadata.config.slippagePct
    }))),
    risk: analyzePortfolioRisk(curve, accepted, cfg.initialCapital),
    assumptions: [
      "Each market first produces canonical candidate fills with the same strategy and execution settings.",
      "Candidate quantities are re-scaled chronologically against one shared mark-to-market equity pool.",
      "Exits and funding are processed before new entries at the same timestamp; equal-time entries use symbol order.",
      "Only the overlapping candle range shared by every selected market is measured.",
      "Portfolio limits can reject or partially allocate a candidate without changing its fill prices or exit reason."
    ]
  };
}

export function sanitizePortfolioBacktestConfig(input: Partial<PortfolioBacktestConfig>): PortfolioBacktestConfig {
  return {
    initialCapital: clamp(input.initialCapital, 100, 1_000_000_000, DEFAULT_PORTFOLIO_BACKTEST_CONFIG.initialCapital),
    maxConcurrentPositions: Math.round(clamp(input.maxConcurrentPositions, 1, 20, DEFAULT_PORTFOLIO_BACKTEST_CONFIG.maxConcurrentPositions)),
    maxGrossExposurePct: clamp(input.maxGrossExposurePct, 1, 2_000, DEFAULT_PORTFOLIO_BACKTEST_CONFIG.maxGrossExposurePct),
    maxPositionExposurePct: clamp(input.maxPositionExposurePct, 1, 1_000, DEFAULT_PORTFOLIO_BACKTEST_CONFIG.maxPositionExposurePct),
    minAllocationPct: clamp(input.minAllocationPct, 0, 100, DEFAULT_PORTFOLIO_BACKTEST_CONFIG.minAllocationPct)
  };
}

function normalizeLegs(legs: PortfolioBacktestLeg[]) {
  const seen = new Set<string>();
  return legs.filter((leg) => {
    const symbol = leg.symbol.trim();
    if (!symbol || seen.has(symbol) || leg.candles.length === 0) return false;
    seen.add(symbol);
    return true;
  }).map((leg) => ({ ...leg, symbol: leg.symbol.trim(), candles: [...leg.candles].sort((a, b) => a.time - b.time) }));
}

function buildCandidates(leg: PortfolioBacktestLeg): Candidate[] {
  const originalCapital = Math.max(1, leg.report.metadata.config.initialCapital);
  return leg.report.trades.map((trade, index) => {
    const originalNotional = Math.abs(trade.entryPrice * trade.qty);
    return {
      id: `${leg.symbol}:${index}`,
      symbol: leg.symbol,
      trade,
      originalCapital,
      originalNotional,
      requestedPct: Math.min(originalNotional / originalCapital * 100, 2_000),
      funding: fundingForTrade(leg.report.executionTrace.events, trade)
    };
  });
}

function fundingForTrade(events: BacktestExecutionEvent[], trade: Trade) {
  return events.flatMap((event) => event.kind === "funding_charged"
    && event.barTime >= trade.entryTime && event.barTime <= trade.exitTime && typeof event.amount === "number"
    ? [{ time: event.barTime, amount: event.amount }] : []);
}

function candidateReportCommission(legs: PortfolioBacktestLeg[], symbol: string) {
  return legs.find((leg) => leg.symbol === symbol)?.report.metadata.config.commissionPct ?? 0;
}

function createPriceReaders(legs: PortfolioBacktestLeg[]) {
  return new Map(legs.map((leg) => {
    let index = -1;
    let close = leg.candles[0]?.close ?? 0;
    return [leg.symbol, {
      advance(time: number) {
        while (index + 1 < leg.candles.length && leg.candles[index + 1].time <= time) close = leg.candles[++index].close;
      },
      price: () => close
    }] as const;
  }));
}

function portfolioEquity(cash: number, active: ActiveCandidate[], prices: ReturnType<typeof createPriceReaders>) {
  return cash + active.reduce((sum, open) => {
    const price = prices.get(open.candidate.symbol)?.price() ?? open.candidate.trade.entryPrice;
    const qty = open.candidate.trade.qty * open.scale;
    const gross = open.candidate.trade.direction === "long"
      ? qty * (price - open.candidate.trade.entryPrice)
      : qty * (open.candidate.trade.entryPrice - price);
    return sum + gross - open.entryCommission;
  }, 0);
}

function grossExposure(active: ActiveCandidate[]) {
  return active.reduce((sum, open) => sum + open.allocatedNotional, 0);
}

function scaleTrade(open: ActiveCandidate): PortfolioTrade {
  const trade = open.candidate.trade;
  return {
    ...trade,
    symbol: open.candidate.symbol,
    qty: trade.qty * open.scale,
    pnl: trade.pnl * open.scale,
    requestedNotional: open.requestedNotional,
    allocatedNotional: open.allocatedNotional,
    allocationPct: open.targetPct,
    scale: open.scale,
    fundingPaid: open.fundingPaid
  };
}

function portfolioMetrics(config: PortfolioBacktestConfig, curve: PortfolioEquityPoint[], trades: PortfolioTrade[], rejected: number, totalCandidates: number, excludedCandidates: number, maxConcurrentPositions: number, fundingPaid: number): PortfolioBacktestMetrics {
  const finalEquity = curve.at(-1)?.equity ?? config.initialCapital;
  const netProfit = finalEquity - config.initialCapital;
  const wins = trades.filter((trade) => trade.pnl - trade.fundingPaid > 0);
  const losses = trades.filter((trade) => trade.pnl - trade.fundingPaid <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl - trade.fundingPaid, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl - trade.fundingPaid, 0));
  let peak = config.initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak - point.equity;
    if (drawdown <= maxDrawdown) continue;
    maxDrawdown = drawdown;
    maxDrawdownPct = peak > 0 ? drawdown / peak * 100 : 0;
  }
  const returns = curve.slice(1).flatMap((point, index) => curve[index].equity > 0 ? [(point.equity - curve[index].equity) / curve[index].equity] : []);
  const average = mean(returns);
  const deviation = standardDeviation(returns, average);
  const interval = median(curve.slice(1).map((point, index) => point.time - curve[index].time).filter((value) => value > 0)) || 60_000;
  return {
    netProfit,
    netProfitPct: netProfit / config.initialCapital * 100,
    finalEquity,
    totalCandidates,
    acceptedTrades: trades.length,
    rejectedTrades: rejected,
    excludedCandidates,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    maxDrawdownPct,
    sharpe: deviation > 0 ? average / deviation * Math.sqrt(365 * 24 * 3_600_000 / interval) : 0,
    timeInMarketPct: curve.length ? curve.filter((point) => point.openPositions > 0).length / curve.length * 100 : 0,
    peakGrossExposurePct: Math.max(0, ...curve.map((point) => point.grossExposurePct)),
    maxConcurrentPositions,
    fundingPaid
  };
}

function symbolContributions(symbols: string[], candidates: Candidate[], trades: PortfolioTrade[], rejected: PortfolioRejectedEntry[], netProfit: number): PortfolioSymbolContribution[] {
  return symbols.map((symbol) => {
    const selected = trades.filter((trade) => trade.symbol === symbol);
    const profit = selected.reduce((sum, trade) => sum + trade.pnl - trade.fundingPaid, 0);
    const funding = selected.reduce((sum, trade) => sum + trade.fundingPaid, 0);
    return {
      symbol,
      candidateTrades: candidates.filter((candidate) => candidate.symbol === symbol).length,
      acceptedTrades: selected.length,
      rejectedTrades: rejected.filter((entry) => entry.symbol === symbol).length,
      wins: selected.filter((trade) => trade.pnl - trade.fundingPaid > 0).length,
      netProfit: profit,
      fundingPaid: funding,
      contributionPct: netProfit === 0 ? 0 : profit / Math.abs(netProfit) * 100
    };
  });
}

function correlationMatrix(legs: PortfolioBacktestLeg[], fromTime: number, toTime: number): PortfolioCorrelationMatrix {
  const symbols = legs.map((leg) => leg.symbol);
  const returns = new Map(legs.map((leg) => [leg.symbol, candleReturns(leg.candles, fromTime, toTime)]));
  const pairs: number[] = [];
  const values = symbols.map((left, row) => symbols.map((right, column) => {
    if (row === column) return 1;
    const value = pearson(returns.get(left) ?? new Map(), returns.get(right) ?? new Map());
    if (row < column && value !== null) pairs.push(value);
    return value;
  }));
  return { symbols, values, averagePairwise: pairs.length ? mean(pairs) : null };
}

function candleReturns(candles: Candle[], fromTime: number, toTime: number) {
  const result = new Map<number, number>();
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (candle.time < fromTime || candle.time > toTime || !(previous.close > 0)) continue;
    result.set(candle.time, (candle.close - previous.close) / previous.close);
  }
  return result;
}

function pearson(left: Map<number, number>, right: Map<number, number>): number | null {
  const pairs = [...left.entries()].flatMap(([time, value]) => right.has(time) ? [[value, right.get(time)!] as const] : []);
  if (pairs.length < 2) return null;
  const meanLeft = mean(pairs.map(([value]) => value));
  const meanRight = mean(pairs.map(([, value]) => value));
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (const [a, b] of pairs) {
    covariance += (a - meanLeft) * (b - meanRight);
    varianceLeft += (a - meanLeft) ** 2;
    varianceRight += (b - meanRight) ** 2;
  }
  const denominator = Math.sqrt(varianceLeft * varianceRight);
  return denominator > 0 ? covariance / denominator : null;
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function standardDeviation(values: number[], average: number) { return values.length < 2 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2))); }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; }
