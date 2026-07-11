export type DurableOrderStatus = "intent" | "unknown" | "accepted" | "partially_filled" | "filled" | "cancelled" | "replaced" | "expired" | "rejected";
export interface DurableOrderState {
    status: DurableOrderStatus;
    qty?: number;
    filledQty?: number;
}
export interface DurableOrderSnapshot {
    status: DurableOrderStatus;
    filledQty: number;
}
export declare function canAdvanceOrderState(record: DurableOrderState, snapshot: DurableOrderSnapshot): boolean;
export interface OrderResultSummary {
    ok: boolean;
    action: string;
    requestedQty?: number;
    orderStatus?: DurableOrderStatus;
    fillQuantities: readonly number[];
}
export declare function deriveDurableOrderStatus(result: OrderResultSummary): DurableOrderStatus;
