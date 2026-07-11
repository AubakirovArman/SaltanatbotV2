import type { BotConfig, OrderJournalRecord, PendingOrder, PositionState } from "./types.js";

export interface ManagedSnapshot {
  side: "long" | "short";
  entry: number;
  qty: number;
  entryTime: number;
  stop?: number;
  target?: number;
  trail?: { mode: "percent" | "atr"; value: number };
}

export interface ReconcileInput {
  config: BotConfig;
  savedManaged?: ManagedSnapshot;
  exchangePosition: PositionState | null;
  openOrders: PendingOrder[];
  now: number;
}

export interface ReconcileResult {
  managed?: ManagedSnapshot;
  pause: boolean;
  messages: string[];
}

export interface OrderReconcileDecision {
  record: OrderJournalRecord;
  status: "accepted" | "unknown";
  message: string;
  exchangeOrderId?: string;
}

/**
 * Resolves crash-left `intent`/`unknown` rows only when the venue exposes a
 * matching open order. Absence is not treated as rejection: a market order may
 * already have filled, so the safe result remains unknown and requires review.
 */
export function reconcileUnresolvedOrders(records: OrderJournalRecord[], openOrders: PendingOrder[]): OrderReconcileDecision[] {
  return records
    .filter((record) => record.status === "intent" || record.status === "unknown")
    .map((record) => {
      const match = openOrders.find((order) =>
        (record.exchangeOrderId !== undefined && order.id === record.exchangeOrderId) ||
        (record.clientId !== undefined && order.clientId === record.clientId)
      );
      if (match) {
        return {
          record,
          status: "accepted" as const,
          message: "Recovered matching open exchange order after restart.",
          exchangeOrderId: match.id
        };
      }
      return {
        record,
        status: "unknown" as const,
        message: "No matching open exchange order was visible after restart; operator review is required."
      };
    });
}

export function reconcileLiveRuntime(input: ReconcileInput): ReconcileResult {
  const messages: string[] = [];
  const saved = input.savedManaged;
  const pos = input.exchangePosition;

  if (!pos) {
    if (saved) messages.push("Saved managed position was cleared because the exchange is flat.");
    return { managed: undefined, pause: false, messages };
  }

  const managed: ManagedSnapshot = {
    side: pos.side,
    entry: pos.entryPrice,
    qty: pos.qty,
    entryTime: saved?.entryTime ?? pos.openedAt ?? input.now,
    stop: saved?.stop,
    target: saved?.target,
    trail: saved?.trail
  };

  let pause = false;
  if (!saved) {
    pause = true;
    messages.push("Exchange has an open position but no saved runtime state; trading is paused for operator review.");
  } else if (saved.side !== pos.side || !near(saved.qty, pos.qty) || !near(saved.entry, pos.entryPrice)) {
    pause = true;
    messages.push("Saved runtime position differs from exchange position; exchange state was adopted and trading is paused.");
  }

  if (input.config.market === "futures" && !hasLocalProtection(managed) && !hasExchangeProtection(pos, input.openOrders)) {
    pause = true;
    messages.push("Open futures position has no visible local or exchange-side protection; trading is paused.");
  }

  return { managed, pause, messages };
}

function hasLocalProtection(managed: ManagedSnapshot): boolean {
  return managed.stop !== undefined || managed.target !== undefined || managed.trail !== undefined;
}

function hasExchangeProtection(position: PositionState, orders: PendingOrder[]): boolean {
  const closingSide = position.side === "long" ? "sell" : "buy";
  return orders.some((order) =>
    order.symbol === position.symbol &&
    order.side === closingSide &&
    (order.reduceOnly || order.type.startsWith("stop") || order.type.startsWith("tp") || order.trgPrice !== undefined)
  );
}

function near(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / scale < 0.000001;
}
