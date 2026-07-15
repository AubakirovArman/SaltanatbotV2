import { orderLifecycle } from "./orderLifecycle.js";
import { getOrderJournal, listOrderEvents, withStoreTransaction } from "./store.js";
import { recordConfirmedFill } from "./spotInventory.js";
import type { FillRecord, OrderJournalRecord } from "./types.js";

export interface ExecutionCommitResult {
  inserted: boolean;
  alreadyAccounted: boolean;
  record: OrderJournalRecord;
}

/**
 * The single accounting boundary for synchronous and private-stream fills.
 * Fill dedupe, spot/futures exposure state and journal accounting commit in one
 * SQLite transaction, so a crash cannot release a reservation halfway through.
 */
export function commitExecutionFill(record: OrderJournalRecord, fill: FillRecord): ExecutionCommitResult {
  return withStoreTransaction(() => {
    assertExecutionMatchesRecord(record, fill);
    if (!recordConfirmedFill(fill, record.market)) {
      const duplicate = listOrderEvents(record.id, 1_000).find((event) => (
        event.type === "fill"
        && typeof event.data === "object"
        && event.data !== null
        && (event.data as { id?: unknown }).id === fill.id
      ));
      if (!duplicate || !sameExecution(duplicate.data, fill)) {
        throw new Error(`Execution ${fill.id} is duplicated without matching durable accounting for order ${record.id}`);
      }
      return { inserted: false, alreadyAccounted: true, record: getOrderJournal(record.id) ?? record };
    }
    return { inserted: true, alreadyAccounted: false, record: orderLifecycle.recordFill(record, fill) };
  });
}

function assertExecutionMatchesRecord(record: OrderJournalRecord, fill: FillRecord): void {
  if (fill.botId !== record.botId || fill.symbol !== record.symbol) {
    throw new Error(`Execution ${fill.id} does not match durable bot and symbol identity for order ${record.id}`);
  }
  if (fill.clientId !== undefined && record.clientId !== undefined && fill.clientId !== record.clientId) {
    throw new Error(`Execution ${fill.id} has a conflicting client identity for order ${record.id}`);
  }
  if (fill.orderId !== undefined && record.exchangeOrderId !== undefined && fill.orderId !== record.exchangeOrderId) {
    throw new Error(`Execution ${fill.id} has a conflicting venue identity for order ${record.id}`);
  }
  if (record.side !== undefined && fill.side !== record.side) {
    throw new Error(`Execution ${fill.id} has a conflicting side for order ${record.id}`);
  }
  const reducing = record.reduceOnly === true || record.action === "close" || record.action === "flatten";
  const opening = record.action === "neworder" || record.action === "open" || record.action === "openorders" || record.action === "spreadentry" || record.action === "replace";
  if ((reducing && fill.kind !== "close") || (!reducing && opening && fill.kind !== "open")) {
    throw new Error(`Execution ${fill.id} has a conflicting exposure kind for order ${record.id}`);
  }
}

function sameExecution(value: unknown, fill: FillRecord): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prior = value as Partial<FillRecord>;
  return prior.id === fill.id
    && prior.botId === fill.botId
    && prior.symbol === fill.symbol
    && prior.side === fill.side
    && prior.qty === fill.qty
    && prior.price === fill.price
    && prior.fee === fill.fee
    && prior.feeAsset === fill.feeAsset
    && prior.realizedPnl === fill.realizedPnl
    && prior.kind === fill.kind
    && prior.orderId === fill.orderId
    && prior.clientId === fill.clientId;
}
