import type { OrderLifecycle } from "./orderLifecycle.js";
import type { ExchangeOrderSnapshot, OrderJournalRecord } from "./types.js";

export type OrderEventIngestResult =
  | { kind: "updated"; record: OrderJournalRecord }
  | { kind: "ignored"; record: OrderJournalRecord; reason: "duplicate" | "identity_conflict" | "invalid_transition" }
  | { kind: "unmatched" };

/**
 * Resolves an exchange event to one durable intent and applies it through the
 * same lifecycle used by REST polling. Private streams can replay events after
 * reconnect without creating duplicate journal updates or regressing state.
 */
export function ingestExchangeOrderEvent(
  records: OrderJournalRecord[],
  snapshot: ExchangeOrderSnapshot,
  lifecycle: Pick<OrderLifecycle, "applySnapshot">
): OrderEventIngestResult {
  const exchangeMatches = records.filter((record) => record.exchangeOrderId === snapshot.id);
  const clientMatches = snapshot.clientId ? records.filter((record) => record.clientId === snapshot.clientId) : [];
  const exchangeRecord = unique(exchangeMatches);
  const clientRecord = unique(clientMatches);
  const conflictRecord = exchangeMatches[0] ?? clientMatches[0];
  if (
    exchangeMatches.length > 1
    || clientMatches.length > 1
    || (exchangeRecord && clientRecord && exchangeRecord.id !== clientRecord.id)
  ) {
    return conflictRecord
      ? { kind: "ignored", record: conflictRecord, reason: "identity_conflict" }
      : { kind: "unmatched" };
  }
  const record = exchangeRecord ?? clientRecord;
  if (!record) return { kind: "unmatched" };

  if (
    (record.exchangeOrderId && record.exchangeOrderId !== snapshot.id)
    || (record.clientId && snapshot.clientId && record.clientId !== snapshot.clientId)
  ) {
    return { kind: "ignored", record, reason: "identity_conflict" };
  }

  const next = lifecycle.applySnapshot(record, snapshot);
  if (next !== record) return { kind: "updated", record: next };
  return {
    kind: "ignored",
    record,
    reason: sameSnapshot(record, snapshot) ? "duplicate" : "invalid_transition"
  };
}

function unique(records: OrderJournalRecord[]) {
  return records.length === 1 ? records[0] : undefined;
}

function sameSnapshot(record: OrderJournalRecord, snapshot: ExchangeOrderSnapshot) {
  return record.status === snapshot.status
    && record.filledQty === snapshot.filledQty
    && record.avgFillPrice === (snapshot.avgFillPrice ?? record.avgFillPrice)
    && record.exchangeOrderId === snapshot.id;
}
