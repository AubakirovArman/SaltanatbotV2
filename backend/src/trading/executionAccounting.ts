import type { ExchangeOrderSnapshot, FillRecord, OrderEventRecord, OrderJournalRecord } from "./types.js";

export function hasRecordedExecution(events: readonly OrderEventRecord[], executionId: string): boolean {
  return events.some((event) =>
    event.type === "fill" && typeof event.data === "object" && event.data !== null
    && (event.data as { id?: unknown }).id === executionId
  );
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
