import { getSpotInventory } from "./spotInventory.js";
import type { Managed, RunningBot } from "./engineRuntime.js";
import type { ExecOrder, ExecResult, FillRecord, OrderJournalRecord, PositionState } from "./types.js";

const CANCEL_ACTIONS = new Set<ExecOrder["action"]>(["cancel", "cancelall", "cancelorphans"]);

export interface ManagedExecutionOutcome {
  changed: boolean;
  cleared: boolean;
  pauseReason?: string;
}

/** Paused runtimes may inspect state, cancel orders, or submit venue-enforced exits only. */
export function pausedOrderAllowed(order: ExecOrder): boolean {
  return order.action === "get" || CANCEL_ACTIONS.has(order.action) || isReduceOnlyExecution(order);
}

export function isReduceOnlyExecution(order: Pick<ExecOrder, "action" | "market" | "reduceOnly" | "side">): boolean {
  if (order.action === "close" || order.action === "flatten") return true;
  if (order.action !== "neworder" || order.reduceOnly !== true) return false;
  return order.market === "futures" || order.side === "sell";
}

/**
 * Apply fills returned synchronously by an adapter to the local managed view.
 * Only fills that crossed the durable accounting boundary are allowed to move
 * the view; an acknowledgement without an immediate market execution pauses a
 * live bot and deliberately preserves its position reservation.
 */
export function applySynchronousReduceOnlyExecution(
  bot: RunningBot,
  order: ExecOrder,
  result: ExecResult,
  committedFills: readonly FillRecord[],
  alreadyAccountedCount = 0
): ManagedExecutionOutcome {
  if (!result.ok || !isReduceOnlyExecution(order)) return { changed: false, cleared: false };

  const expectsImmediateExecution = order.action === "close" || order.action === "flatten" || order.type === "market";
  if (bot.adapter.id !== "paper" && expectsImmediateExecution && result.fills.length === 0) {
    return {
      changed: false,
      cleared: false,
      pauseReason: `Reduce-only close for ${order.symbol} was accepted without authenticated execution accounting; the managed position remains reserved.`
    };
  }
  if (result.fills.length > committedFills.length + alreadyAccountedCount) {
    return {
      changed: false,
      cleared: false,
      pauseReason: `Reduce-only execution accounting for ${order.symbol} was incomplete; the managed position remains reserved.`
    };
  }
  if (!bot.managed || committedFills.length === 0) return { changed: false, cleared: false };

  const executedQty = committedFills.reduce((total, fill) => total + Math.abs(fill.qty), 0);
  if (!Number.isFinite(executedQty) || executedQty <= 0 || executedQty > bot.managed.qty + Number.EPSILON) {
    return {
      changed: false,
      cleared: false,
      pauseReason: `Reduce-only execution quantity for ${order.symbol} conflicts with the managed position; local state was preserved.`
    };
  }
  const remaining = Math.max(0, bot.managed.qty - executedQty);
  if (remaining <= Number.EPSILON) {
    bot.managed = undefined;
    return { changed: true, cleared: true };
  }
  bot.managed = { ...bot.managed, qty: remaining };
  return { changed: true, cleared: false };
}

/**
 * A private authenticated reduce-only fill is committed before this function
 * runs. Futures then adopt the fresh venue position; spot adopts the durable
 * bot-attributed inventory because spot adapters do not expose positions.
 */
export async function reconcileAuthenticatedReduceOnlyExecution(
  bot: RunningBot,
  record: OrderJournalRecord
): Promise<ManagedExecutionOutcome> {
  if (!isReduceOnlyExecution(record)) return { changed: false, cleared: false };
  if (bot.config.market === "spot") {
    const inventory = getSpotInventory(bot.config.id, bot.config.symbol);
    if (!inventory || inventory.remainingQty <= Number.EPSILON) {
      const changed = bot.managed !== undefined;
      bot.managed = undefined;
      return { changed, cleared: true };
    }
    const next: Managed = {
      side: "long",
      entry: inventory.avgPrice,
      qty: inventory.remainingQty,
      entryTime: bot.managed?.entryTime ?? inventory.updatedAt,
      stop: bot.managed?.stop,
      target: bot.managed?.target,
      trail: bot.managed?.trail
    };
    bot.managed = next;
    return { changed: true, cleared: false };
  }

  const venuePosition = await bot.adapter.position(bot.config.symbol);
  return adoptVenuePosition(bot, record, venuePosition);
}

function adoptVenuePosition(bot: RunningBot, record: OrderJournalRecord, position: PositionState | null): ManagedExecutionOutcome {
  const current = bot.managed;
  if (!position) {
    const accounted = record.accountedFilledQty ?? 0;
    if (current && accounted + Number.EPSILON < current.qty) {
      throw new Error("Venue reported a flat position before the authenticated reduce-only quantity could close the managed position");
    }
    bot.managed = undefined;
    return { changed: current !== undefined, cleared: true };
  }
  if (
    position.symbol !== bot.config.symbol
    || !Number.isFinite(position.qty)
    || position.qty <= 0
    || !Number.isFinite(position.entryPrice)
    || position.entryPrice <= 0
  ) {
    throw new Error("Venue returned an invalid position after a reduce-only execution");
  }
  if (current && (current.side !== position.side || position.qty > current.qty + Number.EPSILON)) {
    throw new Error("Venue position conflicts with the managed position after a reduce-only execution");
  }
  bot.managed = {
    side: position.side,
    entry: position.entryPrice,
    qty: position.qty,
    entryTime: current?.entryTime ?? position.openedAt,
    stop: current?.stop,
    target: current?.target,
    trail: current?.trail
  };
  return {
    changed: true,
    cleared: false,
    pauseReason: current ? undefined : "A venue position remained after a reduce-only fill without prior managed state; operator review is required."
  };
}
