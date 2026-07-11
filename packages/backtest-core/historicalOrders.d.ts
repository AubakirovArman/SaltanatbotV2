import type { Candle } from "@saltanatbotv2/contracts";
export type HistoricalOrderType = "market" | "limit" | "stop";
export type HistoricalOrderStatus = "resting" | "partially_filled" | "filled";
export interface HistoricalOrder {
    id: string;
    side: "buy" | "sell";
    type: HistoricalOrderType;
    qty: number;
    filledQty: number;
    price?: number;
    /** Maximum share of candle volume available to this order; 100 by default. */
    participationPct?: number;
}
export interface HistoricalOrderFill {
    orderId: string;
    qty: number;
    price: number;
    fee: number;
    feeAsset: "quote";
    liquidity: "taker" | "maker";
    barTime: number;
}
export interface HistoricalOrderStep {
    order: HistoricalOrder;
    status: HistoricalOrderStatus;
    fill?: HistoricalOrderFill;
}
export interface HistoricalOrderCosts {
    commissionPct: number;
    slippagePct: number;
}
/**
 * Deterministic OHLCV order step. There is no invented intrabar path:
 * market orders use open; limits/stops only use whether their trigger lies in
 * the candle range, with gap-aware price improvement/adverse execution.
 */
export declare function stepHistoricalOrder(input: HistoricalOrder, candle: Candle, costs: HistoricalOrderCosts): HistoricalOrderStep;
export declare function runHistoricalOrder(order: HistoricalOrder, candles: readonly Candle[], costs: HistoricalOrderCosts): HistoricalOrderStep[];
