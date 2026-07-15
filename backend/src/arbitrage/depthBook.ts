import type { SequenceVerifiedL2Book } from "./upstream/l2/types.js";

export type DepthLevel = [number, number];

export interface ArbitrageOrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  source: "rest-snapshot" | "websocket-reconstructed";
  /** True only after the venue-specific snapshot/delta bridge and gap checks. */
  sequenceVerified: boolean;
  /** Venue-provided timestamp only; never synthesized from local time. */
  exchangeTs?: number;
  /** Local receipt time for these exact levels; immutable across cache hits. */
  receivedAt: number;
  sequence?: number;
  /** Internal lease proof; never copied into the HTTP response. */
  sequenceProof?: SequenceVerifiedL2Book;
}

export function validateOrderBook(book: ArbitrageOrderBook, label: string) {
  if (book.sequenceVerified) {
    if (book.source !== "websocket-reconstructed" || !validSequence(book.sequence) || !validTimestamp(book.exchangeTs)) {
      throw new Error(`${label} sequence-verified order book has inconsistent provenance`);
    }
  } else if (book.source !== "rest-snapshot") {
    throw new Error(`${label} unverified order book has inconsistent provenance`);
  }
  for (const [side, rows] of [
    ["bids", book.bids],
    ["asks", book.asks]
  ] as const) {
    if (!Array.isArray(rows) || rows.length > 1_000) throw new Error(`${label} order-book ${side} must contain at most 1000 levels`);
    for (const level of rows) {
      if (!Array.isArray(level) || level.length !== 2 || !Number.isFinite(level[0]) || level[0] <= 0 || !Number.isFinite(level[1]) || level[1] <= 0) {
        throw new Error(`${label} order-book ${side} contains an invalid level`);
      }
    }
  }
  for (let index = 1; index < book.bids.length; index += 1) {
    if ((book.bids[index - 1]?.[0] ?? 0) <= (book.bids[index]?.[0] ?? 0)) throw new Error(`${label} order-book bids must be strictly descending`);
  }
  for (let index = 1; index < book.asks.length; index += 1) {
    if ((book.asks[index - 1]?.[0] ?? 0) >= (book.asks[index]?.[0] ?? 0)) throw new Error(`${label} order-book asks must be strictly ascending`);
  }
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) throw new Error(`${label} order book is crossed or locked`);
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSequence(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
