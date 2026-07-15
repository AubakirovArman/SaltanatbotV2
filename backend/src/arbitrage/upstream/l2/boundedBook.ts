import type { MutableL2Level } from "./types.js";

const DEFAULT_MAX_LEVELS = 1_000;
const MAX_CONFIGURED_LEVELS = 5_000;

/** Mutable absolute-quantity book with a hard per-side memory bound. */
export class BoundedL2Book {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();

  constructor(readonly maxLevels = DEFAULT_MAX_LEVELS) {
    if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > MAX_CONFIGURED_LEVELS) {
      throw new Error(`L2 maxLevels must be between 1 and ${MAX_CONFIGURED_LEVELS}`);
    }
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
  }

  reset(bids: readonly MutableL2Level[], asks: readonly MutableL2Level[]) {
    this.clear();
    this.apply(bids, asks);
  }

  apply(bids: readonly MutableL2Level[], asks: readonly MutableL2Level[]) {
    applySide(this.bids, bids);
    applySide(this.asks, asks);
    trimSide(this.bids, this.maxLevels, "bid");
    trimSide(this.asks, this.maxLevels, "ask");
  }

  snapshot(limit = this.maxLevels): { bids: MutableL2Level[]; asks: MutableL2Level[] } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxLevels) throw new Error("L2 snapshot limit is invalid");
    const bids = sorted(this.bids, "bid").slice(0, limit);
    const asks = sorted(this.asks, "ask").slice(0, limit);
    if (bids.length === 0 || asks.length === 0) throw new Error("Reconstructed L2 book has an empty side");
    if ((bids[0]?.[0] ?? Number.POSITIVE_INFINITY) >= (asks[0]?.[0] ?? 0)) throw new Error("Reconstructed L2 book is crossed or locked");
    return { bids, asks };
  }

  sizes() {
    return { bids: this.bids.size, asks: this.asks.size };
  }
}

export function parseL2Levels(value: unknown, maximum: number): MutableL2Level[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  const output: MutableL2Level[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) return undefined;
    if (!numericInput(row[0]) || !numericInput(row[1])) return undefined;
    const price = Number(row[0]);
    const quantity = Number(row[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0) return undefined;
    output.push([price, quantity]);
  }
  return output;
}

function numericInput(value: unknown): value is string | number {
  return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
}

function applySide(side: Map<number, number>, updates: readonly MutableL2Level[]) {
  for (const [price, quantity] of updates) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0) throw new Error("Invalid L2 level update");
    if (quantity === 0) side.delete(price);
    else side.set(price, quantity);
  }
}

function trimSide(side: Map<number, number>, maximum: number, kind: "bid" | "ask") {
  if (side.size <= maximum) return;
  for (const [price] of sorted(side, kind).slice(maximum)) side.delete(price);
}

function sorted(side: Map<number, number>, kind: "bid" | "ask"): MutableL2Level[] {
  return [...side.entries()].sort((left, right) => (kind === "bid" ? right[0] - left[0] : left[0] - right[0]));
}
