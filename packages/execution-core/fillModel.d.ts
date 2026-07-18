/**
 * Versioned paper fill model shared by the live paper engine adapter and the
 * backtest defaults. This constant is the single fee/slippage parity source:
 * changing the numbers is a new version, never an in-place edit.
 */
export declare const PAPER_FILL_MODEL_V1: Readonly<{
    readonly version: "paper-fill-model-v1";
    /** Taker commission charged on every simulated fill, percent. */
    readonly feePct: 0.05;
    /** Adverse slippage applied to simulated market fills, percent. */
    readonly slipPct: 0.02;
}>;
export type PaperFillModelV1 = typeof PAPER_FILL_MODEL_V1;
