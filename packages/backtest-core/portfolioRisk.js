export const DEFAULT_PORTFOLIO_STRESS_SCENARIOS = Object.freeze([
    Object.freeze({ id: "execution_cost", extraFillCostBps: 5, adverseExitBps: 0, fundingMultiplier: 1 }),
    Object.freeze({ id: "adverse_exit", extraFillCostBps: 0, adverseExitBps: 25, fundingMultiplier: 1 }),
    Object.freeze({ id: "funding_double", extraFillCostBps: 0, adverseExitBps: 0, fundingMultiplier: 2 }),
    Object.freeze({ id: "combined", extraFillCostBps: 5, adverseExitBps: 25, fundingMultiplier: 2 })
]);
/** Analyze one shared-equity portfolio without relying on browser or transport state. */
export function analyzePortfolioRisk(equityCurve, trades, initialCapital, options = {}) {
    const returns = equityReturns(equityCurve);
    return {
        historical: historicalRisk(equityCurve, returns),
        concentration: concentrationRisk(trades),
        monteCarlo: blockBootstrapRisk(returns, initialCapital, options),
        stress: stressPortfolio(equityCurve, trades, initialCapital)
    };
}
export function stressPortfolio(equityCurve, trades, initialCapital, scenarios = DEFAULT_PORTFOLIO_STRESS_SCENARIOS) {
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
function stressScenario(equityCurve, trades, initialCapital, config) {
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
        while (costs[costIndex]?.time <= point.time)
            cumulativeCost += costs[costIndex++].amount;
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
function sanitizeStressConfig(input) {
    return {
        id: input.id,
        extraFillCostBps: clampNumber(input.extraFillCostBps, 0, 10_000, 0),
        adverseExitBps: clampNumber(input.adverseExitBps, 0, 10_000, 0),
        fundingMultiplier: clampNumber(input.fundingMultiplier, 1, 100, 1)
    };
}
function maxDrawdown(curve, initialCapital) {
    let peak = initialCapital;
    let amount = 0;
    let pct = 0;
    for (const point of curve) {
        peak = Math.max(peak, point.equity);
        const current = peak - point.equity;
        if (current <= amount)
            continue;
        amount = current;
        pct = peak > 0 ? current / peak * 100 : 0;
    }
    return { amount, pct };
}
export function blockBootstrapRisk(sourceReturns, initialCapital, options = {}) {
    const clean = sourceReturns.filter((value) => Number.isFinite(value) && value >= -1);
    if (clean.length < 2 || !(initialCapital > 0))
        return null;
    const maxObservations = integer(options.maxObservations, 32, 2_048, 512);
    const returns = compoundBuckets(clean, maxObservations);
    const runs = integer(options.runs, 100, 5_000, 1_000);
    const blockSize = integer(options.blockSize, 1, Math.min(64, returns.length), Math.max(2, Math.round(Math.sqrt(returns.length))));
    const random = mulberry32(seedReturns(returns, runs, blockSize));
    const profits = [];
    const drawdowns = [];
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
                if (equity <= initialCapital * 0.5)
                    hitHalf = true;
                if (equity <= 0)
                    hitRuin = true;
                peak = Math.max(peak, equity);
                maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
            }
        }
        const profit = equity - initialCapital;
        profits.push(profit);
        drawdowns.push(maxDrawdownPct);
        if (profit < 0)
            losses += 1;
        if (hitHalf)
            halves += 1;
        if (hitRuin)
            ruins += 1;
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
function historicalRisk(curve, returns) {
    const sorted = [...returns].sort(ascending);
    const q95 = percentile(sorted, 5);
    const q99 = percentile(sorted, 1);
    const drawdowns = [];
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
function concentrationRisk(trades) {
    const bySymbol = new Map();
    for (const trade of trades)
        bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + Math.max(0, trade.allocatedNotional));
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
function equityReturns(curve) {
    return curve.slice(1).flatMap((point, index) => curve[index].equity > 0
        ? [(point.equity - curve[index].equity) / curve[index].equity]
        : []);
}
function compoundBuckets(values, max) {
    if (values.length <= max)
        return values;
    const bucketSize = Math.ceil(values.length / max);
    const result = [];
    for (let index = 0; index < values.length; index += bucketSize) {
        result.push(values.slice(index, index + bucketSize).reduce((growth, value) => growth * (1 + value), 1) - 1);
    }
    return result;
}
function seedReturns(values, runs, blockSize) {
    let hash = (0x811c9dc5 ^ runs ^ blockSize) >>> 0;
    for (const value of values)
        hash = Math.imul(hash ^ Math.round(value * 1_000_000_000), 0x01000193) >>> 0;
    return hash;
}
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
        return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    };
}
function distribution(sorted) { return { p5: percentile(sorted, 5), p50: percentile(sorted, 50), p95: percentile(sorted, 95) }; }
function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))] ?? 0; }
function tailMean(sorted, threshold) { return mean(sorted.filter((value) => value <= threshold)); }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function ascending(left, right) { return left - right; }
function integer(value, min, max, fallback) { const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback; return Math.min(max, Math.max(min, number)); }
function clampNumber(value, min, max, fallback) { const number = typeof value === "number" && Number.isFinite(value) ? value : fallback; return Math.min(max, Math.max(min, number)); }
