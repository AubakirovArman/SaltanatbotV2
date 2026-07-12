/**
 * Attribute modeled portfolio results to configured commission, slippage and funding.
 * Slippage is reconstructed from recorded adverse fills; this is research TCA, not venue telemetry.
 */
export function analyzePortfolioExecution(trades, assumptions) {
    const normalized = normalizeAssumptions(assumptions);
    const costs = trades.map((trade) => tradeCost(trade, normalized.get(trade.symbol) ?? emptyAssumption(trade.symbol)));
    const symbols = [...new Set([...normalized.keys(), ...trades.map((trade) => trade.symbol)])].sort();
    const reasons = ["signal", "stop", "target", "close", "liquidation"];
    return {
        method: "configured_fill_attribution",
        totals: totals(costs),
        byMarket: symbols.map((symbol) => {
            const assumption = normalized.get(symbol) ?? emptyAssumption(symbol);
            return { symbol, commissionPct: assumption.commissionPct, slippagePct: assumption.slippagePct, ...totals(costs.filter((item) => item.trade.symbol === symbol)) };
        }),
        byExitReason: reasons.flatMap((reason) => {
            const selected = costs.filter((item) => item.trade.reason === reason);
            return selected.length ? [{ reason, ...totals(selected) }] : [];
        })
    };
}
function tradeCost(trade, assumption) {
    const qty = finitePositive(Math.abs(trade.qty));
    const entry = finitePositive(trade.entryPrice);
    const exit = finitePositive(trade.exitPrice);
    const turnover = qty * (entry + exit);
    const filledGrossPnl = trade.direction === "long" ? qty * (exit - entry) : qty * (entry - exit);
    const commissionPaid = Math.max(0, filledGrossPnl - finite(trade.pnl));
    const estimatedSlippageCost = estimatedSlippage(trade, assumption.slippagePct, qty, entry, exit);
    const fundingPaid = Math.max(0, finite(trade.fundingPaid));
    const netPnl = finite(trade.pnl) - fundingPaid;
    const totalCost = commissionPaid + estimatedSlippageCost + fundingPaid;
    return {
        trade,
        assumption,
        turnover,
        referenceGrossPnl: netPnl + totalCost,
        commissionPaid,
        estimatedSlippageCost,
        fundingPaid,
        totalCost,
        netPnl
    };
}
function estimatedSlippage(trade, slippagePct, qty, entry, exit) {
    const rate = clamp(slippagePct, 0, 99.999_999, 0) / 100;
    if (!(rate > 0) || !(qty > 0))
        return 0;
    const entryReference = trade.direction === "long" ? entry / (1 + rate) : entry / (1 - rate);
    const entryCost = trade.direction === "long" ? qty * (entry - entryReference) : qty * (entryReference - entry);
    if (!slippedExit(trade.reason))
        return Math.max(0, entryCost);
    const exitReference = trade.direction === "long" ? exit / (1 - rate) : exit / (1 + rate);
    const exitCost = trade.direction === "long" ? qty * (exitReference - exit) : qty * (exit - exitReference);
    return Math.max(0, entryCost + exitCost);
}
function slippedExit(reason) {
    return reason === "signal" || reason === "stop" || reason === "close";
}
function totals(items) {
    const sum = (pick) => items.reduce((value, item) => value + pick(item), 0);
    const turnover = sum((item) => item.turnover);
    const referenceGrossPnl = sum((item) => item.referenceGrossPnl);
    const commissionPaid = sum((item) => item.commissionPaid);
    const estimatedSlippageCost = sum((item) => item.estimatedSlippageCost);
    const fundingPaid = sum((item) => item.fundingPaid);
    const totalCost = commissionPaid + estimatedSlippageCost + fundingPaid;
    return {
        trades: items.length,
        turnover,
        referenceGrossPnl,
        commissionPaid,
        estimatedSlippageCost,
        fundingPaid,
        totalCost,
        netPnl: sum((item) => item.netPnl),
        allInCostBps: turnover > 0 ? totalCost / turnover * 10_000 : 0,
        costDragPct: referenceGrossPnl !== 0 ? totalCost / Math.abs(referenceGrossPnl) * 100 : null
    };
}
function normalizeAssumptions(values) {
    const result = new Map();
    for (const value of values) {
        const symbol = value.symbol.trim();
        if (!symbol || result.has(symbol))
            continue;
        result.set(symbol, {
            symbol,
            commissionPct: clamp(value.commissionPct, 0, 100, 0),
            slippagePct: clamp(value.slippagePct, 0, 99.999_999, 0)
        });
    }
    return result;
}
function emptyAssumption(symbol) {
    return { symbol, commissionPct: 0, slippagePct: 0 };
}
function finite(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function finitePositive(value) { return Math.max(0, finite(value)); }
function clamp(value, min, max, fallback) { const number = typeof value === "number" && Number.isFinite(value) ? value : fallback; return Math.min(max, Math.max(min, number)); }
