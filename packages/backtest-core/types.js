export const DEFAULT_BACKTEST_CONFIG = Object.freeze({
    initialCapital: 10_000,
    commissionPct: 0.05,
    slippagePct: 0.02,
    allowShort: true,
    fillTiming: "next_open",
    maxLeverage: 5,
    qtyStep: 0,
    fundingRatePctPer8h: 0
});
