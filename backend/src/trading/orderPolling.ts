import type { ExchangeAdapter, ExchangeOrderSnapshot, OrderJournalRecord } from "./types.js";

export interface OrderPollFailure {
  record: OrderJournalRecord;
  error: unknown;
}

export interface OrderPollResult {
  checked: number;
  updated: number;
  failures: OrderPollFailure[];
  nextOffset: number;
}

const POLLABLE = new Set<OrderJournalRecord["status"]>(["accepted", "partially_filled", "unknown"]);

/** Polls a bounded batch sequentially to avoid bursting signed exchange limits. */
export async function pollOrderUpdates(
  records: OrderJournalRecord[],
  adapter: ExchangeAdapter,
  onSnapshot: (record: OrderJournalRecord, snapshot: ExchangeOrderSnapshot) => void | Promise<void>,
  limit = 10,
  offset = 0
): Promise<OrderPollResult> {
  if (!adapter.orderStatus) return { checked: 0, updated: 0, failures: [], nextOffset: 0 };
  const eligible = records
    .filter((record) => POLLABLE.has(record.status) && (record.exchangeOrderId !== undefined || record.clientId !== undefined))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const start = eligible.length > 0 ? offset % eligible.length : 0;
  const pending = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, limit);
  let updated = 0;
  const failures: OrderPollFailure[] = [];
  for (const record of pending) {
    try {
      const snapshot = await adapter.orderStatus(record.symbol, { orderId: record.exchangeOrderId, clientId: record.clientId });
      if (snapshot) {
        await onSnapshot(record, snapshot);
        updated += 1;
      }
    } catch (error) {
      failures.push({ record, error });
    }
  }
  return {
    checked: pending.length,
    updated,
    failures,
    nextOffset: eligible.length > 0 ? (start + pending.length) % eligible.length : 0
  };
}
