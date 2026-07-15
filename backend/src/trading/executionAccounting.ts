import type { ExchangeOrderSnapshot, FillRecord, OrderEventRecord, OrderJournalRecord } from "./types.js";

export function hasRecordedExecution(events: readonly OrderEventRecord[], executionId: string): boolean {
  return events.some((event) =>
    event.type === "fill" && typeof event.data === "object" && event.data !== null
    && (event.data as { id?: unknown }).id === executionId
  );
}

/** Terminal aggregate venue state is not execution proof until every fill is durably accounted. */
export function isTerminalUnaccountedExecution(record: OrderJournalRecord): boolean {
  if (record.status === "intent" || record.status === "accepted" || record.status === "partially_filled" || record.status === "unknown") return false;
  if (record.filledQty === undefined) return record.status === "filled" || record.status === "replaced";
  if (!Number.isFinite(record.filledQty) || record.filledQty < 0) {
    throw new Error(`Order ${record.id} has an invalid venue filled quantity`);
  }
  const accounted = record.accountedFilledQty ?? 0;
  if (!Number.isFinite(accounted) || accounted < 0 || accounted > record.filledQty + Number.EPSILON) {
    throw new Error(`Order ${record.id} has an invalid accounted execution quantity`);
  }
  if ((record.status === "filled" || record.status === "replaced") && record.filledQty <= 0) {
    throw new Error(`Order ${record.id} is terminal-filled without a positive venue execution quantity`);
  }
  return record.filledQty > accounted + Number.EPSILON;
}

export function fillFromExchangeExecution(
  record: OrderJournalRecord,
  snapshot: ExchangeOrderSnapshot
): FillRecord | undefined {
  const execution = snapshot.execution;
  if (!execution) return undefined;
  return {
    id: execution.id,
    botId: record.botId,
    symbol: record.symbol,
    side: execution.side ?? record.side ?? "buy",
    qty: execution.qty,
    price: execution.price,
    fee: execution.fee,
    feeAsset: execution.feeAsset,
    realizedPnl: execution.realizedPnl,
    kind: record.reduceOnly || execution.realizedPnl !== 0 ? "close" : "open",
    reason: record.reason,
    orderId: snapshot.id,
    clientId: snapshot.clientId ?? record.clientId,
    ts: execution.ts
  };
}
