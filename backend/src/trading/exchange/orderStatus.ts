import type { OrderJournalStatus } from "../types.js";

type PollableStatus = Exclude<OrderJournalStatus, "intent" | "replaced">;

export function normalizeBinanceOrderStatus(status: string): PollableStatus {
  switch (status.toUpperCase()) {
    case "NEW": return "accepted";
    case "PARTIALLY_FILLED": return "partially_filled";
    case "FILLED": return "filled";
    case "CANCELED": case "CANCELLED": case "PENDING_CANCEL": return "cancelled";
    case "EXPIRED": case "EXPIRED_IN_MATCH": return "expired";
    case "REJECTED": return "rejected";
    default: return "unknown";
  }
}

export function normalizeBybitOrderStatus(status: string): PollableStatus {
  switch (status.toLowerCase()) {
    case "created": case "new": case "untriggered": case "triggered": case "active": return "accepted";
    case "partiallyfilled": return "partially_filled";
    case "filled": return "filled";
    case "pendingcancel": case "cancelled": case "partiallyfilledcancelled": case "partillyfilledcancelled": return "cancelled";
    case "deactivated": return "expired";
    case "rejected": return "rejected";
    default: return "unknown";
  }
}
