import type { BotConfig, PendingOrder, PositionState } from "./types.js";

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

export function reconcileLiveRuntime(input: ReconcileInput): ReconcileResult {
  const messages: string[] = [];
  const saved = input.savedManaged;
  const pos = input.exchangePosition;

  if (!pos) {
    if (saved) messages.push("Saved managed position was cleared because the exchange is flat.");
    const orphanProtection = input.openOrders.filter((order) => (
      order.symbol === input.config.symbol
      && (order.reduceOnly || order.type.startsWith("stop") || order.type.startsWith("tp") || order.trgPrice !== undefined)
    ));
    if (orphanProtection.length > 0) {
      messages.push(`${orphanProtection.length} reduce-only/protection order(s) remain while the exchange position is flat; cancel or reconcile them before resuming.`);
    }
    return { managed: undefined, pause: orphanProtection.length > 0, messages };
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
