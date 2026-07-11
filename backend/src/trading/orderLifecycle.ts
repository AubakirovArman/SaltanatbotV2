import { randomUUID } from "node:crypto";
import { insertOrderEvent, listOrderEvents, upsertOrderJournal } from "./store.js";
import type { BotConfig, ExecOrder, ExecResult, FillRecord, OrderEventRecord, OrderJournalRecord, OrderJournalStatus } from "./types.js";

export interface OrderLifecycleContext {
  botId: string;
  exchange: BotConfig["exchange"];
  market: BotConfig["market"];
  barTime?: number;
}

export interface OrderLifecycleWriter {
  upsertOrder(record: OrderJournalRecord): void;
  insertEvent(event: OrderEventRecord): void;
  listEvents?(orderId: string): OrderEventRecord[];
}

export interface OrderLifecycleOptions {
  now?: () => number;
  createId?: () => string;
}

const durableWriter: OrderLifecycleWriter = {
  upsertOrder: upsertOrderJournal,
  insertEvent: insertOrderEvent,
  listEvents: (orderId) => listOrderEvents(orderId, 1_000)
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
    const record: OrderJournalRecord = {
      id: order.clientId || order.orderId || this.createId(),
      botId: context.botId,
      exchange: context.exchange,
      market: context.market,
      symbol: order.symbol,
      action: order.action,
      side: order.side,
      type: order.type,
      qty: order.qty,
      reduceOnly: order.reduceOnly,
      reason: order.reason,
      clientId: order.clientId,
      exchangeOrderId: order.orderId,
      status: "intent",
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
    return record;
  }

  complete(record: OrderJournalRecord, result: ExecResult): OrderJournalRecord {
    const now = this.now();
    const status = deriveOrderJournalStatus(record, result);
    const next: OrderJournalRecord = {
      ...record,
      exchangeOrderId: result.order?.id ?? result.pendingOrder?.id ?? record.exchangeOrderId,
      status,
      message: result.message,
      updatedAt: now
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
        fills: result.fills
      },
      ts: now
    });
    for (const fill of result.fills) {
      this.writer.insertEvent({
        id: this.createId(),
        orderId: next.id,
        botId: next.botId,
        type: "fill",
        data: fill,
        ts: fill.ts
      });
    }
    return next;
  }

  markUnknown(record: OrderJournalRecord, error: unknown): OrderJournalRecord {
    const now = this.now();
    const message = error instanceof Error ? error.message : String(error);
    const next: OrderJournalRecord = {
      ...record,
      status: "unknown",
      message,
      updatedAt: now
    };
    this.writer.upsertOrder(next);
    this.writer.insertEvent({
      id: this.createId(),
      orderId: next.id,
      botId: next.botId,
      type: "result",
      data: { status: "unknown", ok: false, message },
      ts: now
    });
    return next;
  }

  recordFill(record: OrderJournalRecord, fill: FillRecord): OrderJournalRecord {
    const now = this.now();
    const priorFilledQty = (this.writer.listEvents?.(record.id) ?? []).reduce(
      (sum, event) => event.type === "fill" && isFillData(event.data) ? sum + Math.abs(event.data.qty) : sum,
      0
    );
    const cumulativeFilledQty = priorFilledQty + Math.abs(fill.qty);
    const status: OrderJournalStatus = record.qty !== undefined && cumulativeFilledQty + Number.EPSILON < Math.abs(record.qty)
      ? "partially_filled"
      : "filled";
    const next: OrderJournalRecord = {
      ...record,
      exchangeOrderId: fill.orderId ?? record.exchangeOrderId,
      status,
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

  reconcile(record: OrderJournalRecord, status: "accepted" | "unknown", message: string, exchangeOrderId?: string): OrderJournalRecord {
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
    const record = this.begin(context, order);
    try {
      const result = await send();
      this.complete(record, result);
      return result;
    } catch (error) {
      this.markUnknown(record, error);
      throw error;
    }
  }
}

export const orderLifecycle = new OrderLifecycle(durableWriter);

export function deriveOrderJournalStatus(record: OrderJournalRecord, result: ExecResult): OrderJournalStatus {
  if (!result.ok) return "rejected";
  if (record.action === "cancel" || record.action === "cancelall" || record.action === "cancelorphans") return "cancelled";
  if (record.action === "replace") return "replaced";
  if (result.order?.status === "filled") return "filled";

  const filledQty = result.fills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0);
  if (filledQty > 0) {
    if (record.qty !== undefined && filledQty + Number.EPSILON < Math.abs(record.qty)) return "partially_filled";
    return "filled";
  }
  return "accepted";
}

function isFillData(value: unknown): value is Pick<FillRecord, "qty"> {
  return typeof value === "object" && value !== null && typeof (value as { qty?: unknown }).qty === "number";
}
