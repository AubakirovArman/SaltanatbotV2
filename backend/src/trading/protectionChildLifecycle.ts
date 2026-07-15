import type {
  BotConfig,
  ExecOrder,
  ExecResult,
  OrderEventRecord,
  OrderJournalRecord,
  OrderJournalStatus,
  OrderType
} from "./types.js";

interface ChildWriter {
  upsertOrder(record: OrderJournalRecord): void;
  insertEvent(event: OrderEventRecord): void;
  getOrder?(id: string): OrderJournalRecord | undefined;
}

interface ChildContext {
  botId: string;
  accountId?: string;
  exchange: BotConfig["exchange"];
  market: BotConfig["market"];
  barTime?: number;
}

type CreateId = () => string;
type ChildRole = "stop" | "take_profit" | "safety_close";

/**
 * Assign every possible protection mutation a deterministic identity and write
 * its intent before the parent adapter performs exchange I/O. Binance can echo
 * all identities; Bybit can echo the emergency close identity while its
 * position-level trading-stop API remains fail-closed through unmatched-event
 * pausing.
 */
export function beginProtectionChildren(
  context: ChildContext,
  parent: OrderJournalRecord,
  order: ExecOrder,
  writer: ChildWriter,
  createId: CreateId
): void {
  if (!needsLiveProtectionChildren(context, order)) return;
  order.protectionClientIds ??= {};
  order.protectionClientIds.stop ??= childClientId(parent.id, "sl");
  order.protectionClientIds.takeProfits ??= (order.takeProfits ?? []).map((_, index) => childClientId(parent.id, `tp${index + 1}`));
  order.protectionClientIds.safetyClose ??= childClientId(parent.id, "safety");

  const children = plannedChildren(context, parent, order);
  for (const child of children) {
    writer.upsertOrder(child.record);
    writer.insertEvent({
      id: createId(),
      orderId: child.record.id,
      botId: child.record.botId,
      type: "intent",
      data: { parentOrderId: parent.id, role: child.role, order: child.record },
      ts: child.record.ts
    });
  }
}

/** Resolve the pre-written child intents from the compound adapter result. */
export function completeProtectionChildren(
  parent: OrderJournalRecord,
  order: ExecOrder | undefined,
  result: ExecResult,
  writer: ChildWriter,
  createId: CreateId,
  now: number
): void {
  if (!order?.protectionClientIds) return;
  const protection = result.protection;
  const orphanIds = new Set(protection?.orphanProtectionOrderIds ?? []);
  const updates: Array<{ id: string | undefined; role: ChildRole; qty?: number; venueId?: string; status: OrderJournalStatus; message: string }> = [];

  if (order.stop && order.protectionClientIds.stop) {
    const venueId = protection?.stopOrderIds?.[0];
    updates.push({ ...childOutcome(order.protectionClientIds.stop, "stop", venueId, protection?.confirmed === true, orphanIds), qty: order.qty });
  }
  for (const [index, id] of (order.protectionClientIds.takeProfits ?? []).entries()) {
    const venueId = protection?.takeProfitOrderIds?.[index];
    const target = order.takeProfits?.[index];
    const qty = target?.qtyBasis === "abs"
      ? target.qty
      : order.qty === undefined || !target ? undefined : order.qty * target.qty / 100;
    updates.push({ ...childOutcome(id, "take_profit", venueId, protection?.confirmed === true, orphanIds), qty });
  }
  if (order.protectionClientIds.safetyClose) {
    const attempted = protection?.safetyCloseAttempted === true;
    updates.push({
      id: order.protectionClientIds.safetyClose,
      role: "safety_close",
      qty: order.qty,
      venueId: protection?.safetyCloseOrderId,
      status: !attempted ? "rejected" : protection?.safetyCloseConfirmed ? "accepted" : "unknown",
      message: !attempted
        ? "Emergency close was not required"
        : protection?.safetyCloseConfirmed
          ? "Emergency close accepted; awaiting authenticated execution"
          : "Emergency close outcome is not proven; operator reconciliation required"
    });
  }

  for (const update of updates) {
    if (!update.id) continue;
    const current = writer.getOrder?.(update.id);
    if (!current) continue;
    const preserveExecution = terminalStatus(current.status) || (current.accountedFilledQty ?? 0) > 0;
    const normalizedQty = validChildQuantity(update.qty, current.accountedFilledQty) ? update.qty : current.qty;
    const next: OrderJournalRecord = {
      ...current,
      qty: normalizedQty,
      exchangeOrderId: current.exchangeOrderId ?? update.venueId,
      status: preserveExecution ? current.status : update.status,
      message: preserveExecution ? current.message ?? update.message : update.message,
      updatedAt: Math.max(now, current.updatedAt)
    };
    writer.upsertOrder(next);
    writer.insertEvent({
      id: createId(),
      orderId: next.id,
      botId: next.botId,
      type: "result",
      data: { parentOrderId: parent.id, role: update.role, status: next.status, exchangeOrderId: next.exchangeOrderId },
      ts: now
    });
  }
}

function needsLiveProtectionChildren(context: ChildContext, order: ExecOrder): boolean {
  return context.exchange !== "paper"
    && context.market === "futures"
    && (order.action === "open" || order.action === "neworder")
    && Boolean(order.stop || order.takeProfits?.length);
}

function plannedChildren(context: ChildContext, parent: OrderJournalRecord, order: ExecOrder) {
  const rows: Array<{ role: ChildRole; record: OrderJournalRecord }> = [];
  const side = order.side === "sell" ? "buy" : "sell";
  const base = (id: string, role: ChildRole, type: OrderType, qty: number | undefined, trgPrice?: number): OrderJournalRecord => ({
    id,
    botId: context.botId,
    accountId: context.accountId,
    exchange: context.exchange,
    market: context.market,
    symbol: order.symbol,
    action: "close",
    side,
    type,
    qty,
    trgPrice,
    reduceOnly: true,
    reason: `protection:${role}:${parent.id}`,
    clientId: id,
    status: "intent",
    executionStatus: "exiting",
    reservedOpenOrderCount: 1,
    barTime: context.barTime,
    ts: parent.ts,
    updatedAt: parent.updatedAt
  });

  if (order.stop && order.protectionClientIds?.stop) {
    rows.push({
      role: "stop",
      record: base(
        order.protectionClientIds.stop,
        "stop",
        "stop_market",
        order.qty,
        order.stop.basis === "price" ? order.stop.value : undefined
      )
    });
  }
  for (const [index, target] of (order.takeProfits ?? []).entries()) {
    const id = order.protectionClientIds?.takeProfits?.[index];
    if (!id) continue;
    const qty = target.qtyBasis === "abs" ? target.qty : order.qty === undefined ? undefined : order.qty * target.qty / 100;
    rows.push({
      role: "take_profit",
      record: base(id, "take_profit", target.limitPrice === undefined ? "tp_market" : "tp_limit", qty, target.priceBasis === "price" ? target.price : undefined)
    });
  }
  if (order.protectionClientIds?.safetyClose) {
    rows.push({
      role: "safety_close",
      record: base(order.protectionClientIds.safetyClose, "safety_close", "market", order.qty)
    });
  }
  return rows;
}

function childOutcome(
  id: string,
  role: Exclude<ChildRole, "safety_close">,
  venueId: string | undefined,
  protectionConfirmed: boolean,
  orphanIds: ReadonlySet<string>
) {
  if (venueId && orphanIds.has(venueId)) {
    return { id, role, venueId, status: "unknown" as const, message: "Protection cancellation is unproven; orphan order may remain" };
  }
  if (protectionConfirmed) {
    return {
      id,
      role,
      venueId,
      status: "accepted" as const,
      message: venueId
        ? "Protection order accepted; awaiting execution"
        : "Position-level protection confirmed without a correlatable child order ID"
    };
  }
  if (venueId) {
    return { id, role, venueId, status: "cancelled" as const, message: "Protection order cancelled after compound entry failure" };
  }
  return {
    id,
    role,
    status: "unknown" as const,
    message: "Protection submission outcome is not proven; reconcile the deterministic client ID"
  };
}

function childClientId(parentId: string, suffix: string): string {
  const tail = `-${suffix}`;
  return `${parentId.slice(0, Math.max(1, 36 - tail.length))}${tail}`;
}

function terminalStatus(status: OrderJournalStatus): boolean {
  return status === "filled" || status === "cancelled" || status === "expired" || status === "rejected" || status === "replaced";
}

function validChildQuantity(qty: number | undefined, accounted: number | undefined): qty is number {
  return qty !== undefined
    && Number.isFinite(qty)
    && qty > 0
    && (accounted === undefined || accounted <= qty + Number.EPSILON);
}
