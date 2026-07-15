import { BoundedL2Book } from "../l2/boundedBook.js";
import type { MutableL2Level } from "../l2/types.js";

export class ContinuousBoundedBook {
  private readonly book: BoundedL2Book;

  constructor(
    maxLevels = 400,
    private readonly publishLevels = Math.min(100, maxLevels)
  ) {
    this.book = new BoundedL2Book(maxLevels);
    if (!Number.isSafeInteger(publishLevels) || publishLevels < 1 || publishLevels > maxLevels) {
      throw new Error("Continuous feed publishLevels is invalid");
    }
  }

  clear() {
    this.book.clear();
  }

  reset(bids: readonly MutableL2Level[], asks: readonly MutableL2Level[]) {
    if (bids.some((level) => level[1] === 0) || asks.some((level) => level[1] === 0)) {
      throw new Error("Full public book snapshot contains a zero-quantity level");
    }
    this.book.reset(bids, asks);
    return this.snapshot();
  }

  apply(bids: readonly MutableL2Level[], asks: readonly MutableL2Level[]) {
    this.book.apply(bids, asks);
    return this.snapshot();
  }

  snapshot() {
    return this.book.snapshot(this.publishLevels);
  }

  retainedDepth() {
    return this.book.maxLevels;
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function safeInteger(value: unknown, minimum = 0): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

export function positiveFinite(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function finite(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validReceivedAt(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
