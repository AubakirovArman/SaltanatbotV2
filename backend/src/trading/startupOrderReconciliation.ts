import { ingestExchangeOrderEvent } from "./orderEventIngest.js";
import { isTerminalUnaccountedExecution } from "./executionAccounting.js";
import { isTerminalUnaccountedRisk } from "./liveRiskReservations.js";
import type { OrderLifecycle } from "./orderLifecycle.js";
import type { ExchangeAdapter, OrderJournalRecord, PendingOrder } from "./types.js";

const IN_FLIGHT = new Set<OrderJournalRecord["status"]>(["intent", "unknown", "accepted", "partially_filled"]);

export interface StartupOrderIssue {
  record: OrderJournalRecord;
  message: string;
  error?: unknown;
}

export interface StartupOrderReconciliationResult {
  checked: number;
  resolved: number;
  updated: number;
  unresolved: StartupOrderIssue[];
}

/**
 * Proves every in-flight journal row from signed venue state before a resumed
 * bot may trade. Queries are intentionally sequential to avoid a restart burst.
 */
export async function reconcileStartupOrders(
  records: OrderJournalRecord[],
  openOrders: PendingOrder[],
  adapter: Pick<ExchangeAdapter, "orderStatus">,
  lifecycle: Pick<OrderLifecycle, "applySnapshot" | "reconcile">
): Promise<StartupOrderReconciliationResult> {
  const pending = records.filter((record) => IN_FLIGHT.has(record.status) || terminalUnaccounted(record)).sort((a, b) => a.updatedAt - b.updatedAt);
  const result: StartupOrderReconciliationResult = { checked: pending.length, resolved: 0, updated: 0, unresolved: [] };

  for (const record of pending) {
    let queryError: unknown;
    if (adapter.orderStatus && (record.exchangeOrderId || record.clientId)) {
      try {
        const snapshot = await adapter.orderStatus(record.symbol, {
          orderId: record.exchangeOrderId,
          clientId: record.clientId
        });
        if (snapshot) {
          if (!provesCommandOutcome(record, snapshot.status)) {
            queryError = new Error(`venue status ${snapshot.status} does not prove ${record.action} completed`);
          } else {
            const ingested = ingestExchangeOrderEvent([record], snapshot, lifecycle);
            if (ingested.kind === "updated") result.updated += 1;
            const snapshotAccepted = ingested.kind === "updated" || (ingested.kind === "ignored" && ingested.reason === "duplicate");
            const acceptedRecord = ingested.kind === "updated" || ingested.kind === "ignored" ? ingested.record : record;
            if (snapshotAccepted && !terminalUnaccounted(acceptedRecord)) {
              result.resolved += 1;
              continue;
            }
            queryError = snapshotAccepted
              ? new Error(`venue status ${acceptedRecord.status} does not include locally accounted execution evidence`)
              : new Error(`venue snapshot was rejected (${ingested.kind === "ignored" ? ingested.reason : "unmatched"})`);
          }
        }
      } catch (error) {
        queryError = error;
      }
    }

    const match = findOpenOrder(record, openOrders);
    if (match && provesOpenOrderOutcome(record)) {
      if (record.status === "intent" || record.status === "unknown" || record.exchangeOrderId !== match.id) {
        lifecycle.reconcile(
          record,
          record.status === "partially_filled" ? "partially_filled" : "accepted",
          "Recovered matching open exchange order after restart.",
          match.id
        );
        result.updated += 1;
      }
      result.resolved += 1;
      continue;
    }

    const message = queryError
      ? `Exchange order status could not be queried after restart: ${messageOf(queryError)}.`
      : "No signed order status or matching open exchange order proved the in-flight outcome after restart.";
    if (record.status === "intent") {
      lifecycle.reconcile(record, "unknown", `${message} Operator review is required.`);
      result.updated += 1;
    }
    result.unresolved.push({ record, message: `${message} Operator review is required.`, error: queryError });
  }

  return result;
}

function terminalUnaccounted(record: OrderJournalRecord) {
  return isTerminalUnaccountedRisk(record) || isTerminalUnaccountedExecution(record);
}

function provesCommandOutcome(record: OrderJournalRecord, status: OrderJournalRecord["status"]) {
  if (record.action === "replace") return false;
  if (record.action === "cancel" || record.action === "cancelall" || record.action === "cancelorphans") {
    return status === "cancelled" || status === "expired" || status === "filled" || status === "rejected";
  }
  return true;
}

function provesOpenOrderOutcome(record: OrderJournalRecord) {
  return record.action !== "replace"
    && record.action !== "cancel"
    && record.action !== "cancelall"
    && record.action !== "cancelorphans";
}

function findOpenOrder(record: OrderJournalRecord, openOrders: PendingOrder[]) {
  return openOrders.find((order) =>
    (record.exchangeOrderId !== undefined && order.id === record.exchangeOrderId)
    || (record.clientId !== undefined && order.clientId === record.clientId)
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
