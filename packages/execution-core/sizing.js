export function resolveExecutionSize(sizing, equity, price, stopPrice, constraints = {}) {
    if (!(price > 0) || !Number.isFinite(price) || !(equity > 0) || !Number.isFinite(equity))
        return { qty: 0 };
    if (!(sizing.value > 0) || !Number.isFinite(sizing.value))
        return { qty: 0 };
    const leverage = Math.max(1, Number.isFinite(constraints.leverage) ? constraints.leverage ?? 1 : 1);
    let qty;
    if (sizing.mode === "units") {
        qty = sizing.value;
    }
    else if (sizing.mode === "risk_pct") {
        if (stopPrice === undefined || !Number.isFinite(stopPrice) || Math.abs(price - stopPrice) === 0) {
            return { qty: 0, warning: "Skipped risk_pct entry: no stop set, so risk-based size is undefined." };
        }
        qty = (equity * (sizing.value / 100)) / Math.abs(price - stopPrice);
    }
    else {
        qty = (equity * (sizing.value / 100) * leverage) / price;
    }
    if (!(qty > 0) || !Number.isFinite(qty))
        return { qty: 0 };
    let warning;
    const maxLeverage = Number.isFinite(constraints.maxLeverage)
        ? Math.max(0, constraints.maxLeverage ?? 0)
        : Number.POSITIVE_INFINITY;
    const maxNotional = equity * maxLeverage;
    if (maxNotional > 0 && price * qty > maxNotional) {
        qty = maxNotional / price;
        warning = `Position clipped to ${maxLeverage}x leverage (requested notional exceeded margin).`;
    }
    const qtyStep = Number.isFinite(constraints.qtyStep) ? Math.max(0, constraints.qtyStep ?? 0) : 0;
    if (qtyStep > 0) {
        qty = Math.floor((qty + Number.EPSILON) / qtyStep) * qtyStep;
        if (!(qty > 0))
            return { qty: 0, warning };
    }
    return { qty, warning };
}
