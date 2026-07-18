import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
export const DEFAULT_BACKTEST_CONFIG = Object.freeze({
    initialCapital: 10_000,
    // Fee/slippage defaults are the shared paper fill model — one parity source.
    commissionPct: PAPER_FILL_MODEL_V1.feePct,
    slippagePct: PAPER_FILL_MODEL_V1.slipPct,
    allowShort: true,
    fillTiming: "next_open",
    maxLeverage: 5,
    qtyStep: 0,
    fundingRatePctPer8h: 0
});
