import type { DydxNodeBookBatch, DydxNodeBookOperation, DydxNodeBookSide, DydxNodeBookView, DydxNodeExecMode, DydxNodeOrder } from "./types.js";
import { dydxValidation, positive, safeInteger, text } from "./validation.js";

const EXEC_MODES = new Set<DydxNodeExecMode>([0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 102]);

export interface DydxNodeBookReconcilerOptions {
  maxOrders?: number;
  maxOperationsPerBatch?: number;
}

/**
 * Pure reducer for decoded full-node stream batches. It deliberately does not open a
 * public gRPC connection: dYdX recommends full-node streaming only against your own node.
 */
export class DydxNodeBookReconciler {
  private readonly clobPairId: number;
  private readonly maxOrders: number;
  private readonly maxOperationsPerBatch: number;
  private orders = new Map<string, DydxNodeOrder>();
  private finalizedOrders?: Map<string, DydxNodeOrder>;
  private status: DydxNodeBookView["status"] = "awaiting-snapshot";
  private blockHeight?: number;
  private finalizedHeight?: number;
  private execMode?: DydxNodeExecMode;
  private invalidReason?: string;

  constructor(clobPairId: number, options: DydxNodeBookReconcilerOptions = {}) {
    this.clobPairId = safeInteger(clobPairId, "clobPairId", 0, 4_294_967_295);
    this.maxOrders = safeInteger(options.maxOrders ?? 100_000, "maxOrders", 1, 250_000);
    this.maxOperationsPerBatch = safeInteger(options.maxOperationsPerBatch ?? 2_000, "maxOperationsPerBatch", 1, 10_000);
  }

  apply(batch: DydxNodeBookBatch): DydxNodeBookView {
    try {
      this.validateBatch(batch);
      if (this.status === "invalidated" && !batch.snapshot) {
        throw dydxValidation("a new full-node snapshot is required after invalidation");
      }
      if (this.status === "awaiting-snapshot" && !batch.snapshot) return this.snapshot();
      if (batch.snapshot) this.applySnapshot(batch);
      else this.applyIncrement(batch);
      return this.snapshot();
    } catch (error) {
      this.status = "invalidated";
      this.invalidReason = (error instanceof Error ? error.message : "invalid full-node batch").slice(0, 300);
      throw error;
    }
  }

  /** Restore the latest `execMode=7` checkpoint and discard later optimistic mutations. */
  revertOptimistic(): DydxNodeBookView {
    if (!this.finalizedOrders || this.finalizedHeight === undefined) {
      this.orders.clear();
      this.status = "awaiting-snapshot";
      this.blockHeight = undefined;
      this.execMode = undefined;
      this.invalidReason = "no finalized checkpoint; a new snapshot is required";
      return this.snapshot();
    }
    this.orders = cloneOrders(this.finalizedOrders);
    this.blockHeight = this.finalizedHeight;
    this.execMode = 7;
    this.status = "finalized";
    this.invalidReason = undefined;
    return this.snapshot();
  }

  reset(reason = "stream generation changed"): DydxNodeBookView {
    this.orders.clear();
    this.finalizedOrders = undefined;
    this.blockHeight = undefined;
    this.finalizedHeight = undefined;
    this.execMode = undefined;
    this.status = "awaiting-snapshot";
    this.invalidReason = text(reason, "reset reason", 200);
    return this.snapshot();
  }

  snapshot(): DydxNodeBookView {
    return {
      status: this.status,
      // Even finalized updates describe one node's off-chain book, not a globally canonical route.
      routeReady: false,
      ...(this.blockHeight === undefined ? {} : { blockHeight: this.blockHeight }),
      ...(this.finalizedHeight === undefined ? {} : { finalizedHeight: this.finalizedHeight }),
      ...(this.execMode === undefined ? {} : { execMode: this.execMode }),
      orderCount: this.orders.size,
      bids: aggregate(this.orders, "bid"),
      asks: aggregate(this.orders, "ask"),
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason })
    };
  }

  private validateBatch(batch: DydxNodeBookBatch): void {
    if (!batch || typeof batch !== "object") throw dydxValidation("full-node batch must be an object");
    const height = safeInteger(batch.blockHeight, "blockHeight", 0, 4_294_967_295);
    if (!EXEC_MODES.has(batch.execMode)) throw dydxValidation(`unsupported execMode ${String(batch.execMode)}`);
    if (batch.execMode === 7 && height === 0) throw dydxValidation("finalized execMode requires a positive blockHeight");
    if (typeof batch.snapshot !== "boolean") throw dydxValidation("snapshot must be boolean");
    if (!Array.isArray(batch.operations)) throw dydxValidation("operations must be an array");
    if (batch.operations.length > this.maxOperationsPerBatch) {
      throw dydxValidation(`full-node batch exceeds ${this.maxOperationsPerBatch} operations`);
    }
    if (this.finalizedHeight !== undefined && height < this.finalizedHeight) {
      throw dydxValidation(`block height ${height} regressed below finalized height ${this.finalizedHeight}`);
    }
  }

  private applySnapshot(batch: DydxNodeBookBatch): void {
    const replacement = new Map<string, DydxNodeOrder>();
    applyOperations(replacement, batch.operations, this.clobPairId, true);
    if (replacement.size > this.maxOrders) throw dydxValidation(`snapshot exceeds ${this.maxOrders} orders`);
    this.orders = replacement;
    this.blockHeight = batch.blockHeight;
    this.execMode = batch.execMode;
    this.invalidReason = undefined;
    this.captureFinality(batch.execMode, batch.blockHeight);
  }

  private applyIncrement(batch: DydxNodeBookBatch): void {
    if (this.blockHeight !== undefined && batch.blockHeight < this.blockHeight) {
      throw dydxValidation(`block height regressed from ${this.blockHeight} to ${batch.blockHeight}; resnapshot required`);
    }
    const next = cloneOrders(this.orders);
    applyOperations(next, batch.operations, this.clobPairId, false);
    if (next.size > this.maxOrders) throw dydxValidation(`full-node book exceeds ${this.maxOrders} orders`);
    this.orders = next;
    this.blockHeight = batch.blockHeight;
    this.execMode = batch.execMode;
    this.captureFinality(batch.execMode, batch.blockHeight);
  }

  private captureFinality(execMode: DydxNodeExecMode, height: number): void {
    if (execMode === 7) {
      this.finalizedOrders = cloneOrders(this.orders);
      this.finalizedHeight = height;
      this.status = "finalized";
    } else {
      this.status = "optimistic";
    }
  }
}

function applyOperations(orders: Map<string, DydxNodeOrder>, operations: readonly DydxNodeBookOperation[], expectedClobPairId: number, snapshot: boolean): void {
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw dydxValidation("node operation must be an object");
    if (operation.kind === "place") {
      const order = normalizedOrder(operation.order, expectedClobPairId);
      if (orders.has(order.orderId)) throw dydxValidation(`duplicate node order ${order.orderId}`);
      orders.set(order.orderId, order);
    } else if (operation.kind === "fill") {
      const orderId = orderToken(operation.orderId);
      const current = orders.get(orderId);
      if (!current) throw dydxValidation(`fill references unknown order ${orderId}`);
      const totalFilledQuantums = safeInteger(operation.totalFilledQuantums, `${orderId}.totalFilledQuantums`, 0);
      if (totalFilledQuantums > current.initialQuantums) throw dydxValidation(`fill exceeds initial quantums for ${orderId}`);
      // Absolute fills may decrease while optimistic matches are removed and replayed.
      orders.set(orderId, { ...current, filledQuantums: totalFilledQuantums });
    } else if (operation.kind === "remove") {
      if (snapshot) throw dydxValidation("snapshot cannot contain remove operations");
      const orderId = orderToken(operation.orderId);
      if (!orders.delete(orderId)) throw dydxValidation(`remove references unknown order ${orderId}`);
    } else {
      throw dydxValidation(`unsupported node operation ${(operation as { kind?: unknown }).kind as string}`);
    }
  }
}

function normalizedOrder(order: DydxNodeOrder, expectedClobPairId: number): DydxNodeOrder {
  if (!order || typeof order !== "object") throw dydxValidation("placed order must be an object");
  const clobPairId = safeInteger(order.clobPairId, "order.clobPairId", 0, 4_294_967_295);
  if (clobPairId !== expectedClobPairId) throw dydxValidation(`unexpected clobPairId ${clobPairId}`);
  if (order.side !== "bid" && order.side !== "ask") throw dydxValidation("order.side must be bid or ask");
  const initialQuantums = safeInteger(order.initialQuantums, "order.initialQuantums", 1);
  const filledQuantums = safeInteger(order.filledQuantums, "order.filledQuantums", 0);
  if (filledQuantums > initialQuantums) throw dydxValidation("order filledQuantums exceeds initialQuantums");
  return {
    orderId: orderToken(order.orderId),
    clobPairId,
    side: order.side,
    price: positive(order.price, "order.price"),
    initialQuantums,
    filledQuantums
  };
}

function aggregate(orders: ReadonlyMap<string, DydxNodeOrder>, side: DydxNodeBookSide): readonly (readonly [price: number, remainingQuantums: number, orderCount: number])[] {
  const levels = new Map<number, { quantity: number; count: number }>();
  for (const order of orders.values()) {
    if (order.side !== side) continue;
    const remaining = order.initialQuantums - order.filledQuantums;
    if (remaining === 0) continue;
    const level = levels.get(order.price) ?? { quantity: 0, count: 0 };
    const quantity = level.quantity + remaining;
    if (!Number.isSafeInteger(quantity)) throw dydxValidation(`aggregate quantity at ${order.price} exceeds safe integer range`);
    levels.set(order.price, { quantity, count: level.count + 1 });
  }
  return [...levels.entries()].sort(([left], [right]) => (side === "bid" ? right - left : left - right)).map(([price, level]) => [price, level.quantity, level.count] as const);
}

function cloneOrders(input: ReadonlyMap<string, DydxNodeOrder>): Map<string, DydxNodeOrder> {
  return new Map([...input].map(([id, order]) => [id, { ...order }]));
}

function orderToken(value: string): string {
  const normalized = text(value, "orderId", 200);
  if (!/^[A-Za-z0-9._:/+-]+$/.test(normalized)) throw dydxValidation("orderId has invalid format");
  return normalized;
}
