import { listRiskOrderJournal } from "./store.js";
import type { BotConfig, ExecOrder, OrderJournalRecord, PendingOrder } from "./types.js";

const MAX_RISK_ORDERS = 1_000;
const RESERVABLE_STATUSES = new Set<OrderJournalRecord["status"]>([
  "intent",
  "accepted",
  "partially_filled",
  "unknown",
  "filled",
  "cancelled",
  "expired",
  "rejected",
  "replaced"
]);

export const riskIncreasingActions = new Set<OrderJournalRecord["action"]>([
  "neworder",
  "open",
  "openorders",
  "spreadentry",
  "turnover",
  "replace"
]);

type RiskIdentity = Pick<BotConfig, "exchange" | "market" | "symbol">;

export interface LiveRiskReservation {
  id: string;
  exchangeOrderId?: string;
  clientId?: string;
  side: "buy" | "sell";
  type: OrderJournalRecord["type"];
  remainingQty: number;
  price?: number;
  trgPrice?: number;
  openOrderSlots: number;
}

/** Load a bounded journal slice; overflow is ambiguous and therefore unsafe. */
export function loadLiveRiskJournal(botId: string): OrderJournalRecord[] {
  return boundedLiveRiskJournal(listRiskOrderJournal(botId, MAX_RISK_ORDERS + 1));
}

export function boundedLiveRiskJournal(records: OrderJournalRecord[]): OrderJournalRecord[] {
  if (records.length > MAX_RISK_ORDERS) {
    throw new Error(`Live risk journal exceeds the ${MAX_RISK_ORDERS}-order safety bound`);
  }
  return records;
}

/**
 * Convert durable orders into reservations. `filledQty` is deliberately not
 * used: venue order state can say filled before the execution stream has been
 * committed to local inventory/accounting.
 */
export function buildLiveRiskReservations(
  identity: RiskIdentity,
  records: readonly OrderJournalRecord[]
): LiveRiskReservation[] {
  const reservations: LiveRiskReservation[] = [];
  for (const record of records) {
    if (!RESERVABLE_STATUSES.has(record.status) || !riskIncreasingActions.has(record.action)) continue;
    if (record.market === "futures" && record.reduceOnly) continue;

    const qty = requiredPositive(record.qty, `Order ${record.id} has no durable base quantity`);
    const targetQty = reservationTargetQuantity(record, qty);
    const accounted = accountedQuantity(record);
    if (accounted > targetQty + Number.EPSILON) {
      throw new Error(`Order ${record.id} has accounted quantity greater than its reservable execution quantity`);
    }
    const remainingQty = Math.max(0, targetQty - accounted);
    if (remainingQty <= Number.EPSILON) continue;

    if (record.exchange !== identity.exchange || record.market !== identity.market || record.symbol !== identity.symbol) {
      throw new Error(`Order ${record.id} has unresolved risk for a different exchange, market, or symbol`);
    }
    if (record.side !== "buy" && record.side !== "sell") {
      throw new Error(`Order ${record.id} has no measurable side`);
    }
    validateOptionalPrice(record.price, record.id, "price");
    validateOptionalPrice(record.trgPrice, record.id, "trigger price");
    reservations.push({
      id: record.id,
      exchangeOrderId: record.exchangeOrderId,
      clientId: record.clientId,
      side: record.side,
      type: record.type,
      remainingQty,
      price: record.price,
      trgPrice: record.trgPrice,
      openOrderSlots: activeOrderStatus(record.status)
        ? requiredOpenOrderSlots(record.reservedOpenOrderCount, record.id)
        : 0
    });
  }
  return reservations;
}

/** Quantity still able to become locally unaccounted exposure for one row. */
export function unaccountedRiskQuantity(record: OrderJournalRecord): number {
  if (!RESERVABLE_STATUSES.has(record.status) || !riskIncreasingActions.has(record.action)) return 0;
  if (record.market === "futures" && record.reduceOnly) return 0;
  const qty = requiredPositive(record.qty, `Order ${record.id} has no durable base quantity`);
  const targetQty = reservationTargetQuantity(record, qty);
  const accounted = accountedQuantity(record);
  if (accounted > targetQty + Number.EPSILON) {
    throw new Error(`Order ${record.id} has accounted quantity greater than its reservable execution quantity`);
  }
  return Math.max(0, targetQty - accounted);
}

export function isTerminalUnaccountedRisk(record: OrderJournalRecord): boolean {
  return !activeOrderStatus(record.status) && unaccountedRiskQuantity(record) > Number.EPSILON;
}

/** Conservatively reserve the entry plus every requested child/protection leg. */
export function requestedOpenOrderSlots(order: ExecOrder): number {
  let entries = 1;
  if (order.action === "spreadentry") entries = Math.max(1, Math.round(order.spreadCount ?? 1));
  else if (order.action === "turnover") entries = 2;
  const protections = (order.stop ? 1 : 0) + (order.takeProfits?.length ?? 0);
  return entries + protections;
}

export function pendingMatchesReservation(pending: PendingOrder, reservation: LiveRiskReservation): boolean {
  return (
    (reservation.exchangeOrderId !== undefined && reservation.exchangeOrderId === pending.id)
    || (reservation.clientId !== undefined && reservation.clientId === pending.clientId)
  );
}

function accountedQuantity(record: OrderJournalRecord): number {
  if (record.accountedFilledQty === undefined) return 0;
  if (!Number.isFinite(record.accountedFilledQty) || record.accountedFilledQty < 0) {
    throw new Error(`Order ${record.id} has an invalid accounted fill quantity`);
  }
  return record.accountedFilledQty;
}

function reservationTargetQuantity(record: OrderJournalRecord, requestedQty: number): number {
  if (activeOrderStatus(record.status) || record.status === "filled" || record.status === "replaced") {
    return requestedQty;
  }
  if (record.filledQty === undefined) {
    return record.status === "rejected" ? 0 : requestedQty;
  }
  if (!Number.isFinite(record.filledQty) || record.filledQty < 0 || record.filledQty > requestedQty + Number.EPSILON) {
    throw new Error(`Order ${record.id} has an invalid venue filled quantity`);
  }
  return Math.min(requestedQty, record.filledQty);
}

function activeOrderStatus(status: OrderJournalRecord["status"]): boolean {
  return status === "intent" || status === "accepted" || status === "partially_filled" || status === "unknown";
}

function requiredOpenOrderSlots(value: number | undefined, id: string): number {
  const slots = value ?? 1;
  if (!Number.isSafeInteger(slots) || slots <= 0) throw new Error(`Order ${id} has an invalid open-order reservation`);
  return slots;
}

function requiredPositive(value: number | undefined, message: string): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) throw new Error(message);
  return value as number;
}

function validateOptionalPrice(value: number | undefined, id: string, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`Order ${id} has an invalid ${label}`);
  }
}
