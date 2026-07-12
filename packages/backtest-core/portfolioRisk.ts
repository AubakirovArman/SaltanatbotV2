import type { PortfolioEquityPoint, PortfolioTrade } from "./portfolioBacktest.js";

export interface RiskPercentiles { p5: number; p50: number; p95: number; }

export interface PortfolioHistoricalRisk {
  observations: number;
  lossProbabilityPct: number;
  valueAtRisk95Pct: number;
  expectedShortfall95Pct: number;
  valueAtRisk99Pct: number;
  expectedShortfall99Pct: number;
  worstPeriodPct: number;
  ulcerIndex: number;
  longestRecoveryPeriods: number;
}

export interface PortfolioConcentrationRisk {
  largestSymbol: string | null;
  largestAllocationPct: number;
  effectiveSymbols: number;
  herfindahlIndex: number;
  allocations: Array<{ symbol: string; allocatedNotional: number; sharePct: number }>;
}

export interface PortfolioMonteCarloRisk {
  method: "moving_block_bootstrap";
  runs: number;
  observations: number;
  sourceObservations: number;
  blockSize: number;
  netProfit: RiskPercentiles;
  maxDrawdownPct: RiskPercentiles;
  probabilityOfLossPct: number;
  riskOfHalfPct: number;
  riskOfRuinPct: number;
}

export interface PortfolioRiskAnalysis {
  historical: PortfolioHistoricalRisk;
  concentration: PortfolioConcentrationRisk;
  monteCarlo: PortfolioMonteCarloRisk | null;
  stress: PortfolioStressAnalysis;
}

export interface PortfolioRiskOptions { runs?: number; maxObservations?: number; blockSize?: number; }

export type PortfolioStressScenarioId = "execution_cost" | "adverse_exit" | "funding_double" | "combined";

export interface PortfolioStressConfig {
  id: PortfolioStressScenarioId | "custom";
  /** Additional adverse basis points charged independently on entry and exit notional. */
  extraFillCostBps: number;
  /** Additional adverse basis points charged once on exit notional. */
  adverseExitBps: number;
  /** Adverse multiplier applied to observed funding; values below one clamp to one. */
  fundingMultiplier: number;
}

export interface PortfolioStressScenario extends PortfolioStressConfig {
  extraCost: number;
  netProfit: number;
  netProfitPct: number;
  finalEquity: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  deltaFromBaseline: number;
  profitable: boolean;
}

export interface PortfolioStressAnalysis {
  baselineNetProfit: number;
  turnover: number;
  breakEvenExtraFillCostBps: number | null;
  scenarios: PortfolioStressScenario[];
}

export const DEFAULT_PORTFOLIO_STRESS_SCENARIOS: ReadonlyArray<Readonly<PortfolioStressConfig>> = Object.freeze([
  Object.freeze({ id: "execution_cost", extraFillCostBps: 5, adverseExitBps: 0, fundingMultiplier: 1 }),
  Object.freeze({ id: "adverse_exit", extraFillCostBps: 0, adverseExitBps: 25, fundingMultiplier: 1 }),
  Object.freeze({ id: "funding_double", extraFillCostBps: 0, adverseExitBps: 0, fundingMultiplier: 2 }),
  Object.freeze({ id: "combined", extraFillCostBps: 5, adverseExitBps: 25, fundingMultiplier: 2 })
]);

/** Analyze one shared-equity portfolio without relying on browser or transport state. */
export function analyzePortfolioRisk(
  equityCurve: PortfolioEquityPoint[],
  trades: PortfolioTrade[],
  initialCapital: number,
  options: PortfolioRiskOptions = {}
): PortfolioRiskAnalysis {
  const returns = equityReturns(equityCurve);
  return {
    historical: historicalRisk(equityCurve, returns),
    concentration: concentrationRisk(trades),
    monteCarlo: blockBootstrapRisk(returns, initialCapital, options),
    stress: stressPortfolio(equityCurve, trades, initialCapital)
  };
}

export function stressPortfolio(
  equityCurve: PortfolioEquityPoint[],
  trades: PortfolioTrade[],
  initialCapital: number,
  scenarios: ReadonlyArray<Readonly<PortfolioStressConfig>> = DEFAULT_PORTFOLIO_STRESS_SCENARIOS
): PortfolioStressAnalysis {
  const baselineFinal = equityCurve.at(-1)?.equity ?? initialCapital;
  const baselineNetProfit = baselineFinal - initialCapital;
  const turnover = trades.reduce((sum, trade) => sum + Math.abs(trade.qty) * (trade.entryPrice + trade.exitPrice), 0);
  return {
    baselineNetProfit,
    turnover,
    breakEvenExtraFillCostBps: baselineNetProfit > 0 && turnover > 0 ? baselineNetProfit / turnover * 10_000 : null,
    scenarios: scenarios.map((input) => stressScenario(equityCurve, trades, initialCapital, sanitizeStressConfig(input)))
  };
}

function stressScenario(
  equityCurve: PortfolioEquityPoint[],
  trades: PortfolioTrade[],
  initialCapital: number,
  config: PortfolioStressConfig
): PortfolioStressScenario {
  const costs = trades.map((trade) => ({
    time: trade.exitTime,
    amount: Math.abs(trade.qty) * (trade.entryPrice + trade.exitPrice) * config.extraFillCostBps / 10_000
      + Math.abs(trade.qty * trade.exitPrice) * config.adverseExitBps / 10_000
      + Math.max(0, trade.fundingPaid) * Math.max(0, config.fundingMultiplier - 1)
  })).sort((left, right) => left.time - right.time);
  const extraCost = costs.reduce((sum, item) => sum + item.amount, 0);
  let costIndex = 0;
  let cumulativeCost = 0;
  const stressed = equityCurve.map((point) => {
    while (costs[costIndex]?.time <= point.time) cumulativeCost += costs[costIndex++].amount;
    return { time: point.time, equity: point.equity - cumulativeCost };
  });
  const baselineFinal = equityCurve.at(-1)?.equity ?? initialCapital;
  const finalEquity = baselineFinal - extraCost;
  const netProfit = finalEquity - initialCapital;
  const drawdown = maxDrawdown([...stressed, { time: equityCurve.at(-1)?.time ?? 0, equity: finalEquity }], initialCapital);
  return {
    ...config,
    extraCost,
    netProfit,
    netProfitPct: initialCapital > 0 ? netProfit / initialCapital * 100 : 0,
    finalEquity,
    maxDrawdown: drawdown.amount,
    maxDrawdownPct: drawdown.pct,
    deltaFromBaseline: -extraCost,
    profitable: netProfit > 0
  };
}

function sanitizeStressConfig(input: Readonly<PortfolioStressConfig>): PortfolioStressConfig {
  return {
    id: input.id,
    extraFillCostBps: clampNumber(input.extraFillCostBps, 0, 10_000, 0),
    adverseExitBps: clampNumber(input.adverseExitBps, 0, 10_000, 0),
    fundingMultiplier: clampNumber(input.fundingMultiplier, 1, 100, 1)
  };
}

function maxDrawdown(curve: Array<{ equity: number }>, initialCapital: number) {
  let peak = initialCapital;
  let amount = 0;
  let pct = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    const current = peak - point.equity;
    if (current <= amount) continue;
    amount = current;
    pct = peak > 0 ? current / peak * 100 : 0;
  }
  return { amount, pct };
}

export function blockBootstrapRisk(
  sourceReturns: number[],
  initialCapital: number,
  options: PortfolioRiskOptions = {}
): PortfolioMonteCarloRisk | null {
  const clean = sourceReturns.filter((value) => Number.isFinite(value) && value >= -1);
  if (clean.length < 2 || !(initialCapital > 0)) return null;
  const maxObservations = integer(options.maxObservations, 32, 2_048, 512);
  const returns = compoundBuckets(clean, maxObservations);
  const runs = integer(options.runs, 100, 5_000, 1_000);
  const blockSize = integer(options.blockSize, 1, Math.min(64, returns.length), Math.max(2, Math.round(Math.sqrt(returns.length))));
  const random = mulberry32(seedReturns(returns, runs, blockSize));
  const profits: number[] = [];
  const drawdowns: number[] = [];
  let losses = 0;
  let halves = 0;
  let ruins = 0;

  for (let run = 0; run < runs; run += 1) {
    let equity = initialCapital;
    let peak = initialCapital;
    let maxDrawdownPct = 0;
    let hitHalf = false;
    let hitRuin = false;
    let index = 0;
    while (index < returns.length) {
      const start = Math.floor(random() * returns.length);
      for (let offset = 0; offset < blockSize && index < returns.length; offset += 1, index += 1) {
        equity *= 1 + returns[(start + offset) % returns.length];
        if (equity <= initialCapital * 0.5) hitHalf = true;
        if (equity <= 0) hitRuin = true;
        peak = Math.max(peak, equity);
        maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
      }
    }
    const profit = equity - initialCapital;
    profits.push(profit);
    drawdowns.push(maxDrawdownPct);
    if (profit < 0) losses += 1;
    if (hitHalf) halves += 1;
    if (hitRuin) ruins += 1;
  }

  profits.sort(ascending);
  drawdowns.sort(ascending);
  return {
    method: "moving_block_bootstrap",
    runs,
    observations: returns.length,
    sourceObservations: clean.length,
    blockSize,
    netProfit: distribution(profits),
    maxDrawdownPct: distribution(drawdowns),
    probabilityOfLossPct: losses / runs * 100,
    riskOfHalfPct: halves / runs * 100,
    riskOfRuinPct: ruins / runs * 100
  };
}

function historicalRisk(curve: PortfolioEquityPoint[], returns: number[]): PortfolioHistoricalRisk {
  const sorted = [...returns].sort(ascending);
  const q95 = percentile(sorted, 5);
  const q99 = percentile(sorted, 1);
  const drawdowns: number[] = [];
  let peak = curve[0]?.equity ?? 0;
  let peakIndex = 0;
  let longestRecoveryPeriods = 0;
  for (let index = 0; index < curve.length; index += 1) {
    const equity = curve[index].equity;
    if (equity >= peak) {
      peak = equity;
      peakIndex = index;
    }
    drawdowns.push(peak > 0 ? (peak - equity) / peak * 100 : 0);
    longestRecoveryPeriods = Math.max(longestRecoveryPeriods, index - peakIndex);
  }
  return {
    observations: returns.length,
    lossProbabilityPct: returns.length ? returns.filter((value) => value < 0).length / returns.length * 100 : 0,
    valueAtRisk95Pct: Math.max(0, -q95 * 100),
    expectedShortfall95Pct: Math.max(0, -tailMean(sorted, q95) * 100),
    valueAtRisk99Pct: Math.max(0, -q99 * 100),
    expectedShortfall99Pct: Math.max(0, -tailMean(sorted, q99) * 100),
    worstPeriodPct: Math.max(0, -(sorted[0] ?? 0) * 100),
    ulcerIndex: Math.sqrt(mean(drawdowns.map((value) => value ** 2))),
    longestRecoveryPeriods
  };
}

function concentrationRisk(trades: PortfolioTrade[]): PortfolioConcentrationRisk {
  const bySymbol = new Map<string, number>();
  for (const trade of trades) bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + Math.max(0, trade.allocatedNotional));
  const total = [...bySymbol.values()].reduce((sum, value) => sum + value, 0);
  const allocations = [...bySymbol].map(([symbol, allocatedNotional]) => ({
    symbol,
    allocatedNotional,
    sharePct: total > 0 ? allocatedNotional / total * 100 : 0
  })).sort((left, right) => right.allocatedNotional - left.allocatedNotional || left.symbol.localeCompare(right.symbol));
  const herfindahlIndex = allocations.reduce((sum, item) => sum + (item.sharePct / 100) ** 2, 0);
  return {
    largestSymbol: allocations[0]?.symbol ?? null,
    largestAllocationPct: allocations[0]?.sharePct ?? 0,
    effectiveSymbols: herfindahlIndex > 0 ? 1 / herfindahlIndex : 0,
    herfindahlIndex,
    allocations
  };
}

function equityReturns(curve: PortfolioEquityPoint[]) {
  return curve.slice(1).flatMap((point, index) => curve[index].equity > 0
    ? [(point.equity - curve[index].equity) / curve[index].equity]
    : []);
}

function compoundBuckets(values: number[], max: number) {
  if (values.length <= max) return values;
  const bucketSize = Math.ceil(values.length / max);
  const result: number[] = [];
  for (let index = 0; index < values.length; index += bucketSize) {
    result.push(values.slice(index, index + bucketSize).reduce((growth, value) => growth * (1 + value), 1) - 1);
  }
  return result;
}

function seedReturns(values: number[], runs: number, blockSize: number) {
  let hash = (0x811c9dc5 ^ runs ^ blockSize) >>> 0;
  for (const value of values) hash = Math.imul(hash ^ Math.round(value * 1_000_000_000), 0x01000193) >>> 0;
  return hash;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function distribution(sorted: number[]): RiskPercentiles { return { p5: percentile(sorted, 5), p50: percentile(sorted, 50), p95: percentile(sorted, 95) }; }
function percentile(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))] ?? 0; }
function tailMean(sorted: number[], threshold: number) { return mean(sorted.filter((value) => value <= threshold)); }
function mean(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function ascending(left: number, right: number) { return left - right; }
function integer(value: unknown, min: number, max: number, fallback: number) { const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback; return Math.min(max, Math.max(min, number)); }
function clampNumber(value: unknown, min: number, max: number, fallback: number) { const number = typeof value === "number" && Number.isFinite(value) ? value : fallback; return Math.min(max, Math.max(min, number)); }
