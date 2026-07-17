import { createHash, randomUUID } from "node:crypto";
import { canAdvanceOrderState, deriveDurableOrderStatus } from "@saltanatbotv2/execution-core";
import { getOrderJournal, insertOrderEvent, listOrderEvents, upsertOrderJournal } from "./store.js";
import { requestedOpenOrderSlots } from "./liveRiskReservations.js";
import { canonicalPersistedOrderIntent } from "./orderIntentComparison.js";
import { beginProtectionChildren, completeProtectionChildren } from "./protectionChildLifecycle.js";
import type { BotConfig, ExchangeOrderSnapshot, ExecOrder, ExecResult, ExecutionLifecycleStatus, FillRecord, OrderEventRecord, OrderJournalRecord, OrderJournalStatus } from "./types.js";

export interface OrderLifecycleContext {
  botId: string;
  accountId?: string;
  exchange: BotConfig["exchange"];
  market: BotConfig["market"];
  barTime?: number;
}

export interface OrderLifecycleWriter {
  upsertOrder(record: OrderJournalRecord): void;
  insertEvent(event: OrderEventRecord): void;
  getOrder?(botId: string, id: string): OrderJournalRecord | undefined;
  listEvents?(botId: string, orderId: string): OrderEventRecord[];
}

export interface OrderLifecycleOptions {
  now?: () => number;
  createId?: () => string;
}

const durableWriter: OrderLifecycleWriter = {
  upsertOrder: upsertOrderJournal,
  insertEvent: insertOrderEvent,
  getOrder: (botId, id) => getOrderJournal(botId, id),
  listEvents: (botId, orderId) => listOrderEvents(botId, orderId, 1_000)
};

/**
 * Persists the order intent before exchange I/O and records the terminal result
 * afterwards. A thrown adapter call is deliberately classified as `unknown`:
 * the exchange may have accepted the request before the transport failed.
 */
export class OrderLifecycle {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly writer: OrderLifecycleWriter,
    options: OrderLifecycleOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  begin(context: OrderLifecycleContext, order: ExecOrder): OrderJournalRecord {
    const now = this.now();
    const identity = order.clientId || order.orderId || this.createId();
    if (!order.clientId && !order.orderId) order.clientId = identity;
    const canonicalOrder = canonicalPersistedOrderIntent(order);
    const existing = this.writer.getOrder?.(context.botId, identity);
    if (existing) {
      assertOrderReplayMatches(existing, context, order, canonicalOrder, this.writer.listEvents?.(context.botId, identity));
      return existing;
    }
    const record: OrderJournalRecord = {
      id: identity,
      botId: context.botId,
      intentHash: createHash("sha256").update(canonicalOrder).digest("hex"),
      accountId: context.accountId,
      exchange: context.exchange,
      market: context.market,
      symbol: order.symbol,
      action: order.action,
      side: order.side,
      type: order.type,
      qty: order.qty,
      price: order.price,
      trgPrice: order.trgPrice,
      reduceOnly: order.reduceOnly,
      reason: order.reason,
      clientId: order.clientId,
      exchangeOrderId: order.orderId,
      status: "intent",
      executionStatus: initialExecutionStatus(order),
      reservedOpenOrderCount: requestedOpenOrderSlots(order),
      barTime: context.barTime,
      ts: now,
      updatedAt: now
    };
    this.writer.upsertOrder(record);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: record.id,
      botId: record.botId,
      type: "intent",
      data: order,
      ts: now
    });
    beginProtectionChildren(context, record, order, this.writer, () => this.createId());
    return record;
  }

  complete(record: OrderJournalRecord, result: ExecResult, submittedOrder?: ExecOrder): OrderJournalRecord {
    const now = this.now();
    const current = this.writer.getOrder?.(record.botId, record.id) ?? record;
    const resultStatus = deriveOrderJournalStatus(current, result);
    const lifecycleTransitions = executionLifecycleTransitions(current, result);
    const filledQty = result.fills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0);
    const filledNotional = result.fills.reduce((sum, fill) => sum + Math.abs(fill.qty) * fill.price, 0);
    const observedFilledQty = Math.max(current.filledQty ?? 0, filledQty);
    const status = canAdvanceOrderState(current, { status: resultStatus, filledQty: observedFilledQty })
      ? resultStatus
      : current.status;
    const preserveNewerExecution = terminalOrderStatus(current.status)
      || (current.accountedFilledQty ?? 0) > (record.accountedFilledQty ?? 0);
    const next: OrderJournalRecord = {
      ...current,
      qty: normalizedSubmittedQuantity(current, submittedOrder),
      exchangeOrderId: current.exchangeOrderId ?? result.order?.id ?? result.pendingOrder?.id ?? result.protection?.entryOrderId,
      status,
      executionStatus: lifecycleTransitions.at(-1) ?? current.executionStatus,
      message: preserveNewerExecution ? current.message ?? result.message : result.message,
      filledQty: observedFilledQty > 0 ? observedFilledQty : current.filledQty,
      avgFillPrice: preserveNewerExecution
        ? current.avgFillPrice ?? (filledQty > 0 ? filledNotional / filledQty : undefined)
        : filledQty > 0 ? filledNotional / filledQty : current.avgFillPrice,
      updatedAt: Math.max(now, current.updatedAt)
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "result",
      data: {
        status: next.status,
        ok: result.ok,
        message: result.message,
        protection: result.protection,
        pendingOrder: result.pendingOrder,
        order: result.order,
        position: result.position,
        account: result.account,
        fills: result.fills,
        lifecycleTransitions
      },
      ts: now
    });
    completeProtectionChildren(next, submittedOrder, result, this.writer, () => this.createId(), now);
    return next;
  }

  markUnknown(record: OrderJournalRecord, error: unknown): OrderJournalRecord {
    const now = this.now();
    const message = error instanceof Error ? error.message : String(error);
    const current = this.writer.getOrder?.(record.botId, record.id) ?? record;
    const preserveNewerExecution = terminalOrderStatus(current.status)
      || (current.accountedFilledQty ?? 0) > (record.accountedFilledQty ?? 0);
    const next: OrderJournalRecord = {
      ...current,
      status: preserveNewerExecution ? current.status : "unknown",
      message: preserveNewerExecution ? current.message ?? message : message,
      updatedAt: Math.max(now, current.updatedAt)
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "result",
      data: { status: next.status, ok: false, message },
      ts: now
    });
    return next;
  }

  recordFill(record: OrderJournalRecord, fill: FillRecord): OrderJournalRecord {
    const now = this.now();
    const priorAccountedQty = record.accountedFilledQty ?? 0;
    if (!Number.isFinite(priorAccountedQty) || priorAccountedQty < 0) {
      throw new Error(`Order ${record.id} has invalid prior accounted quantity`);
    }
    const fillQty = Math.abs(fill.qty);
    if (!Number.isFinite(fillQty) || fillQty <= 0) throw new Error("Execution fill quantity must be positive");
    const cumulativeAccountedQty = priorAccountedQty + fillQty;
    if (record.qty !== undefined && cumulativeAccountedQty > Math.abs(record.qty) + Number.EPSILON) {
      throw new Error(`Execution accounting exceeds requested quantity for order ${record.id}`);
    }
    const observedFilledQty = Math.max(record.filledQty ?? 0, cumulativeAccountedQty);
    const status: OrderJournalStatus = terminalOrderStatus(record.status)
      ? record.status
      : record.qty !== undefined && observedFilledQty + Number.EPSILON < Math.abs(record.qty)
        ? "partially_filled"
        : "filled";
    const next: OrderJournalRecord = {
      ...record,
      exchangeOrderId: fill.orderId ?? record.exchangeOrderId,
      status,
      filledQty: observedFilledQty,
      accountedFilledQty: cumulativeAccountedQty,
      message: `Asynchronous fill ${fill.qty} @ ${fill.price}`,
      updatedAt: now
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "fill",
      data: fill,
      ts: fill.ts
    });
    return next;
  }

  applySnapshot(record: OrderJournalRecord, snapshot: ExchangeOrderSnapshot): OrderJournalRecord {
    if (record.clientId && snapshot.clientId && record.clientId !== snapshot.clientId) return record;
    if (!canApplySnapshot(record, snapshot)) return record;
    const avgFillPrice = snapshot.avgFillPrice ?? record.avgFillPrice;
    if (
      record.status === snapshot.status &&
      record.filledQty === snapshot.filledQty &&
      record.avgFillPrice === avgFillPrice &&
      record.exchangeOrderId === snapshot.id
    ) return record;
    const next: OrderJournalRecord = {
      ...record,
      exchangeOrderId: snapshot.id,
      clientId: record.clientId ?? snapshot.clientId,
      status: snapshot.status,
      filledQty: snapshot.filledQty,
      avgFillPrice,
      message: `Exchange status: ${snapshot.status}`,
      updatedAt: Math.max(this.now(), snapshot.updatedAt)
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "update",
      data: snapshot,
      ts: snapshot.updatedAt
    });
    return next;
  }

  reconcile(record: OrderJournalRecord, status: "accepted" | "partially_filled" | "unknown", message: string, exchangeOrderId?: string): OrderJournalRecord {
    const now = this.now();
    const next: OrderJournalRecord = {
      ...record,
      exchangeOrderId: exchangeOrderId ?? record.exchangeOrderId,
      status,
      message,
      updatedAt: now
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "reconcile",
      data: { status, message, exchangeOrderId: next.exchangeOrderId },
      ts: now
    });
    return next;
  }

  async execute(context: OrderLifecycleContext, order: ExecOrder, send: () => Promise<ExecResult>): Promise<ExecResult> {
    const suppliedIdentity = order.clientId || order.orderId;
    const existing = suppliedIdentity
      ? this.writer.getOrder?.(context.botId, suppliedIdentity)
      : undefined;
    const record = this.begin(context, order);
    if (existing) {
      if (context.exchange !== "paper") {
        throw new Error(`Execution identity ${record.id} already exists and requires reconciliation before live retry`);
      }
      if (terminalOrderStatus(existing.status)) {
        throw new Error(`Paper execution identity ${record.id} is already terminal and cannot be resubmitted`);
      }
    }
    try {
      const result = await send();
      this.complete(record, result, order);
      return result;
    } catch (error) {
      this.markUnknown(record, error);
      throw error;
    }
  }
}

function assertOrderReplayMatches(
  record: OrderJournalRecord,
  context: OrderLifecycleContext,
  order: ExecOrder,
  canonicalOrder: string,
  events: OrderEventRecord[] | undefined
): void {
  if (
    record.botId !== context.botId
    || record.accountId !== context.accountId
    || record.exchange !== context.exchange
    || record.market !== context.market
    || record.barTime !== context.barTime
  ) {
    throw new Error(`Execution identity ${record.id} belongs to another durable context`);
  }
  const original = events?.find((event) => event.type === "intent");
  const canonicalHash = createHash("sha256").update(canonicalOrder).digest("hex");
  if (record.intentHash && record.intentHash !== canonicalHash) {
    throw new Error(`Execution identity ${record.id} was already used for another order`);
  }
  if (!record.intentHash && original && canonicalPersistedOrderIntent(original.data) !== canonicalOrder) {
    throw new Error(`Execution identity ${record.id} was already used for another order`);
  }
  if (!record.intentHash && !original) {
    throw new Error(`Execution identity ${record.id} lacks a durable canonical intent and cannot be retried`);
  }
}

function initialExecutionStatus(order: ExecOrder): ExecutionLifecycleStatus | undefined {
  if (order.action === "close" || order.action === "flatten" || order.reduceOnly) return "exiting";
  if (order.action === "open" || order.action === "neworder") return "entry_submitted";
  return undefined;
}

export function executionLifecycleTransitions(record: OrderJournalRecord, result: ExecResult): ExecutionLifecycleStatus[] {
  if (record.executionStatus === "exiting") return result.ok ? ["exiting"] : ["exiting", "error"];
  if (record.executionStatus !== "entry_submitted") return result.ok ? [] : ["error"];
  if (!result.ok && !result.protection?.requested) return ["entry_submitted", "error"];
  const transitions: ExecutionLifecycleStatus[] = ["entry_submitted", "entry_confirmed"];
  if (!result.protection?.requested) return transitions;
  transitions.push("protection_submitted");
  if (result.protection.confirmed) transitions.push("protection_confirmed", "open_protected");
  else transitions.push("open_unprotected", "error");
  return transitions;
}

export const orderLifecycle = new OrderLifecycle(durableWriter);

/** Reject replayed or out-of-order venue updates that would regress durable state. */
export function canApplySnapshot(record: OrderJournalRecord, snapshot: ExchangeOrderSnapshot): boolean {
  return canAdvanceOrderState(record, snapshot);
}

export function deriveOrderJournalStatus(record: OrderJournalRecord, result: ExecResult): OrderJournalStatus {
  return deriveDurableOrderStatus({
    ok: result.ok,
    action: record.action,
    requestedQty: record.qty,
    orderStatus: result.order?.status === "filled" ? "filled" : undefined,
    fillQuantities: result.fills.map((fill) => fill.qty),
  });
}

function terminalOrderStatus(status: OrderJournalStatus): boolean {
  return status === "filled" || status === "cancelled" || status === "expired" || status === "rejected" || status === "replaced";
}

function normalizedSubmittedQuantity(record: OrderJournalRecord, order: ExecOrder | undefined): number | undefined {
  if (order?.qty === undefined || order.qty === record.qty) return record.qty;
  if (!Number.isFinite(order.qty) || order.qty <= 0) throw new Error(`Order ${record.id} has invalid submitted quantity`);
  if (record.qty !== undefined && order.qty > record.qty + Number.EPSILON) {
    throw new Error(`Order ${record.id} submitted quantity exceeds its durable intent`);
  }
  return order.qty;
}
