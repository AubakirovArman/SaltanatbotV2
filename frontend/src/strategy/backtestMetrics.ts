import type { Candle } from "../types";
import type { BacktestConfig, BacktestMetrics, EquityPoint, Trade } from "./backtestTypes";

export function computeBacktestMetrics(
  trades: Trade[], equityCurve: EquityPoint[], config: BacktestConfig,
  barsInMarket: number, measuredBars: number, candles: Candle[],
  liquidated: boolean, fundingPaid = 0
): BacktestMetrics {
  const startEquity = equityCurve[0]?.equity ?? config.initialCapital;
  const finalEquity = equityCurve.at(-1)?.equity ?? config.initialCapital;
  const netProfit = finalEquity - startEquity;
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  let peak = startEquity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    }
  }
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const previous = equityCurve[i - 1].equity;
    if (previous > 0) returns.push((equityCurve[i].equity - previous) / previous);
  }
  const meanReturn = mean(returns);
  const deviation = std(returns, meanReturn);
  const barMs = candles.length > 1 ? medianDelta(candles) : 60_000;
  const barsPerYear = (365 * 24 * 3600 * 1000) / barMs;
  const avgMaePct = trades.length ? trades.reduce((sum, trade) => sum + trade.maePct, 0) / trades.length : 0;
  const avgMfePct = trades.length ? trades.reduce((sum, trade) => sum + trade.mfePct, 0) / trades.length : 0;
  return {
    netProfit,
    netProfitPct: startEquity > 0 ? (netProfit / startEquity) * 100 : 0,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    maxDrawdownPct,
    sharpe: deviation > 0 ? (meanReturn / deviation) * Math.sqrt(barsPerYear) : 0,
    avgTrade: trades.length ? netProfit / trades.length : 0,
    expectancy: trades.length ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length : 0,
    timeInMarketPct: measuredBars > 0 ? (Math.min(barsInMarket, measuredBars) / measuredBars) * 100 : 0,
    finalEquity, avgMaePct, avgMfePct, fundingPaid, liquidated
  };
}

function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function std(values: number[], average: number) {
  return values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}
export function medianDelta(candles: Candle[]) {
  const deltas: number[] = [];
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i += 1) deltas.push(candles[i].time - candles[i - 1].time);
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || 60_000;
}
