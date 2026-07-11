export function applyExecutionSlippage(price, direction, entering, slippagePct) {
    if (!Number.isFinite(price) || price <= 0)
        return 0;
    const boundedSlippage = Number.isFinite(slippagePct) ? Math.max(0, slippagePct) : 0;
    const worseUp = (direction === "long") === entering;
    const factor = worseUp ? 1 + boundedSlippage / 100 : 1 - boundedSlippage / 100;
    return price * factor;
}
export function resolveProtectionPrice(kind, direction, entry, level, atr) {
    if (!level)
        return undefined;
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(level.value) || level.value < 0)
        return undefined;
    if (level.mode === "price")
        return level.value > 0 ? level.value : undefined;
    const adverse = kind === "stop";
    const lower = (direction === "long") === adverse;
    const distance = level.mode === "percent"
        ? entry * (level.value / 100)
        : Math.max(0, Number.isFinite(atr) ? atr : 0) * level.value;
    return lower ? entry - distance : entry + distance;
}
