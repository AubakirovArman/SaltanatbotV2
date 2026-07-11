import { applyExecutionSlippage, resolveExecutionSize, resolveProtectionPrice, } from "@saltanatbotv2/execution-core";
export function applySlippage(price, direction, entering, config) {
    return applyExecutionSlippage(price, direction, entering, config.slippagePct);
}
export function resolveStop(direction, entry, stop, atr) {
    return resolveProtectionPrice("stop", direction, entry, stop, atr) ?? 0;
}
export function resolveTarget(direction, entry, target, atr) {
    return resolveProtectionPrice("target", direction, entry, target, atr) ?? 0;
}
export function resolveSize(sizing, equity, price, stopPrice, config) {
    return resolveExecutionSize(sizing, equity, price, stopPrice, {
        leverage: 1,
        maxLeverage: config.maxLeverage,
        qtyStep: config.qtyStep,
    });
}
export function stopHit(position, candle) {
    if (position.stopPrice === undefined)
        return false;
    return position.dir === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
}
export function targetHit(position, candle) {
    if (position.targetPrice === undefined)
        return false;
    return position.dir === "long" ? candle.high >= position.targetPrice : candle.low <= position.targetPrice;
}
export function unrealized(position, price) {
    if (!position)
        return 0;
    return position.dir === "long"
        ? position.qty * (price - position.entryPrice)
        : position.qty * (position.entryPrice - price);
}
