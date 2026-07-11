export type DurableOrderStatus =
  | "intent"
  | "unknown"
  | "accepted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "replaced"
  | "expired"
  | "rejected";

export interface DurableOrderState {
  status: DurableOrderStatus;
  qty?: number;
  filledQty?: number;
}

export interface DurableOrderSnapshot {
  status: DurableOrderStatus;
  filledQty: number;
}

const terminalStatuses = new Set<DurableOrderStatus>(["filled", "cancelled", "replaced", "expired", "rejected"]);

export function canAdvanceOrderState(record: DurableOrderState, snapshot: DurableOrderSnapshot): boolean {
  if (terminalStatuses.has(record.status)) return false;
  if ((record.filledQty ?? 0) > snapshot.filledQty + Number.EPSILON) return false;
  switch (record.status) {
    case "intent":
    case "unknown":
      return true;
    case "accepted":
      return snapshot.status !== "unknown" && snapshot.status !== "intent";
    case "partially_filled":
      return snapshot.status === "partially_filled"
        || snapshot.status === "filled"
        || snapshot.status === "cancelled"
        || snapshot.status === "expired";
    default:
      return false;
  }
}

export interface OrderResultSummary {
  ok: boolean;
  action: string;
  requestedQty?: number;
  orderStatus?: DurableOrderStatus;
  fillQuantities: readonly number[];
}

export function deriveDurableOrderStatus(result: OrderResultSummary): DurableOrderStatus {
  if (!result.ok) return "rejected";
  if (result.action === "cancel" || result.action === "cancelall" || result.action === "cancelorphans") return "cancelled";
  if (result.action === "replace") return "replaced";
  if (result.orderStatus === "filled") return "filled";
  const filledQty = result.fillQuantities.reduce((sum, qty) => sum + Math.abs(qty), 0);
  if (filledQty > 0) {
    if (result.requestedQty !== undefined && filledQty + Number.EPSILON < Math.abs(result.requestedQty)) {
      return "partially_filled";
    }
    return "filled";
  }
  return "accepted";
}
